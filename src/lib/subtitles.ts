import type { Env, SubtitleSource } from "../types";
import { extractVideoId, toSafeErrorMessage } from "./utils";
import { fetchWithOptionalProxy } from "./proxy-http";

interface TranscriptResult {
  videoId: string;
  transcript: string;
  source: SubtitleSource;
  detail: string;
}

interface CaptionTrack {
  baseUrl: string;
  languageCode?: string;
  name?: { simpleText?: string };
}

function decodeEscapedJsonString(input: string): string {
  return input
    .replace(/\\u0026/g, "&")
    .replace(/\\\//g, "/")
    .replace(/\\n/g, "")
    .replace(/\\"/g, '"');
}

function extractBalancedJson(raw: string, startToken: string): string | null {
  const start = raw.indexOf(startToken);
  if (start < 0) return null;

  let cursor = start + startToken.length;
  while (cursor < raw.length && raw[cursor] !== "{") cursor++;
  if (cursor >= raw.length) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = cursor; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "{") depth++;
    if (ch === "}") depth--;

    if (depth === 0) {
      return raw.slice(cursor, i + 1);
    }
  }

  return null;
}

function transcriptFromJson3(payload: any): string {
  const events = Array.isArray(payload?.events) ? payload.events : [];
  const lines: string[] = [];

  for (const event of events) {
    if (!Array.isArray(event?.segs)) continue;
    const text = event.segs
      .map((seg: any) => (typeof seg?.utf8 === "string" ? seg.utf8 : ""))
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (text) lines.push(text);
  }

  return lines.join("\n");
}

function transcriptFromXml(xml: string): string {
  const lines = Array.from(xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)).map((m) =>
    m[1]
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, " ")
      .trim()
  );
  return lines.filter(Boolean).join("\n");
}

function preview(text: string, max = 160): string {
  return text.replace(/\s+/g, " ").slice(0, max);
}

function rankTracks(captionTracks: CaptionTrack[]): CaptionTrack[] {
  const preferred = ["zh-Hans", "zh-CN", "zh-TW", "zh-Hant", "zh", "en"];
  const rank = (track: CaptionTrack) => {
    const code = (track.languageCode || "").toLowerCase();
    const idx = preferred.findIndex((p) => p.toLowerCase() === code);
    return idx >= 0 ? idx : 999;
  };

  return [...captionTracks].sort((a, b) => rank(a) - rank(b));
}

async function fetchTrackOnce(
  url: URL,
  env: Env,
  timeoutMs: number,
  proxySessionId: string
): Promise<string> {
  const response = await fetchWithOptionalProxy(url, env, timeoutMs, { proxySessionId });
  if (!response.ok) {
    const bodyPreview = preview(await response.text());
    throw new Error(`Caption fetch failed: ${response.status}, body=${bodyPreview}`);
  }

  const raw = await response.text();
  if (!raw.trim()) {
    throw new Error("Caption response empty");
  }

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("application/json") || raw.trim().startsWith("{")) {
    try {
      const payload = JSON.parse(raw);
      const transcript = transcriptFromJson3(payload);
      if (!transcript) throw new Error("json3 events empty");
      return transcript;
    } catch (error) {
      throw new Error(`Caption json parse failed: ${toSafeErrorMessage(error)}; raw=${preview(raw)}`);
    }
  }

  const transcript = transcriptFromXml(raw);
  if (!transcript) {
    throw new Error(`Caption xml parsed but transcript empty; raw=${preview(raw)}`);
  }
  return transcript;
}

function extractPoToken(watchHtml: string): string | null {
  const match = watchHtml.match(/"poToken":"([^"]+)"/);
  if (!match?.[1]) return null;
  try {
    return decodeEscapedJsonString(match[1]);
  } catch {
    return match[1];
  }
}

function withPoToken(url: URL, poToken: string | null): URL {
  const copied = new URL(url.toString());
  if (!poToken) return copied;
  if (!copied.searchParams.get("pot")) {
    copied.searchParams.set("pot", poToken);
    copied.searchParams.set("potc", "1");
  }
  return copied;
}

async function fetchTrackTranscript(
  track: CaptionTrack,
  env: Env,
  timeoutMs: number,
  poToken: string | null,
  proxySessionId: string
): Promise<string> {
  const decodedBase = decodeEscapedJsonString(track.baseUrl);
  const baseUrl = new URL(decodedBase);

  const attempts: URL[] = [];

  const json3 = new URL(baseUrl.toString());
  json3.searchParams.set("fmt", "json3");
  attempts.push(withPoToken(json3, poToken));

  attempts.push(withPoToken(baseUrl, poToken));

  const xml = new URL(baseUrl.toString());
  xml.searchParams.set("fmt", "srv3");
  attempts.push(withPoToken(xml, poToken));

  let lastError: unknown = null;
  for (const target of attempts) {
    try {
      const transcript = await fetchTrackOnce(target, env, timeoutMs, proxySessionId);
      if (transcript.trim()) return transcript;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("track transcript fetch failed");
}

async function fetchYoutubeTranscriptByVideoId(videoId: string, env: Env): Promise<string> {
  const timeoutMs = Number.parseInt(env.YOUTUBE_FETCH_TIMEOUT_MS || "12000", 10);
  const proxySessionId = String(Math.floor(100000 + Math.random() * 900000));
  const watchUrl = new URL(`https://www.youtube.com/watch?v=${videoId}`);
  const watchResp = await fetchWithOptionalProxy(watchUrl, env, timeoutMs, { proxySessionId });
  if (!watchResp.ok) {
    const bodyPreview = preview(await watchResp.text(), 200);
    throw new Error(`YouTube watch page fetch failed: ${watchResp.status}, body=${bodyPreview}`);
  }

  const watchHtml = await watchResp.text();
  const captionsJsonRaw =
    extractBalancedJson(watchHtml, '"captions":') ||
    extractBalancedJson(watchHtml, '"captions": ');

  if (!captionsJsonRaw) {
    throw new Error("Cannot locate captions metadata, possible bot-check or no subtitles");
  }

  const captions = JSON.parse(captionsJsonRaw);
  const captionTracks = captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(captionTracks) || captionTracks.length === 0) {
    throw new Error("No caption tracks found on video");
  }
  const poToken = extractPoToken(watchHtml);

  const ordered = rankTracks(captionTracks as CaptionTrack[]);
  const errors: string[] = [];

  for (const track of ordered) {
    try {
      const transcript = await fetchTrackTranscript(track, env, timeoutMs, poToken, proxySessionId);
      if (transcript.trim()) return transcript;
      errors.push(`lang=${track.languageCode || "unknown"}: empty transcript`);
    } catch (error) {
      errors.push(`lang=${track.languageCode || "unknown"}: ${toSafeErrorMessage(error)}`);
    }
  }

  throw new Error(`All caption tracks failed. details=${errors.slice(0, 4).join(" | ")}`);
}

export async function resolveTranscript(
  youtubeUrl: string,
  subtitleInput: string | undefined,
  env: Env
): Promise<TranscriptResult> {
  const videoId = extractVideoId(youtubeUrl);
  if (!videoId) {
    throw new Error("无效的 YouTube 链接，未解析到 videoId");
  }

  try {
    const transcript = await fetchYoutubeTranscriptByVideoId(videoId, env);
    return {
      videoId,
      transcript,
      source: "youtube",
      detail: "实时抓取 YouTube 字幕成功"
    };
  } catch (error) {
    const fallback = (subtitleInput || "").trim();
    if (!fallback) {
      throw new Error(`YouTube 字幕抓取失败，且未提供用户字幕。原因: ${toSafeErrorMessage(error)}`);
    }
    return {
      videoId,
      transcript: fallback,
      source: "user_input",
      detail: `YouTube 字幕抓取失败，已使用用户输入字幕。原因: ${toSafeErrorMessage(error)}`
    };
  }
}
