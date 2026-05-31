import type { Env, SubtitleSource } from "../types";
import { extractVideoId, toSafeErrorMessage } from "./utils";
import { fetchWithOptionalProxy } from "./proxy-http";

interface TranscriptResult {
  videoId: string;
  transcript: string;
  source: SubtitleSource;
  detail: string;
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

function pickTrack(captionTracks: Array<{ baseUrl: string; languageCode?: string; name?: { simpleText?: string } }>) {
  const preferred = ["zh-Hans", "zh-CN", "zh-TW", "zh-Hant", "zh", "en"];
  for (const lang of preferred) {
    const track = captionTracks.find((item) => item.languageCode?.toLowerCase() === lang.toLowerCase());
    if (track) return track;
  }
  return captionTracks[0];
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

async function fetchYoutubeTranscriptByVideoId(videoId: string, env: Env): Promise<string> {
  const timeoutMs = Number.parseInt(env.YOUTUBE_FETCH_TIMEOUT_MS || "12000", 10);
  const watchUrl = new URL(`https://www.youtube.com/watch?v=${videoId}`);
  const watchResp = await fetchWithOptionalProxy(watchUrl, env, timeoutMs);
  if (!watchResp.ok) {
    const bodyPreview = (await watchResp.text()).slice(0, 200).replace(/\s+/g, " ");
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

  const track = pickTrack(captionTracks);
  if (!track?.baseUrl) {
    throw new Error("No valid caption track baseUrl");
  }

  const decodedBase = decodeEscapedJsonString(track.baseUrl);
  const json3Url = new URL(decodedBase);
  json3Url.searchParams.set("fmt", "json3");

  const captionResp = await fetchWithOptionalProxy(json3Url, env, timeoutMs);
  if (!captionResp.ok) {
    const bodyPreview = (await captionResp.text()).slice(0, 200).replace(/\s+/g, " ");
    throw new Error(`Caption track fetch failed: ${captionResp.status}, body=${bodyPreview}`);
  }

  const contentType = captionResp.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const payload = await captionResp.json();
    const transcript = transcriptFromJson3(payload);
    if (!transcript) throw new Error("Caption json3 parsed but transcript empty");
    return transcript;
  }

  const raw = await captionResp.text();
  if (raw.trim().startsWith("{")) {
    const payload = JSON.parse(raw);
    const transcript = transcriptFromJson3(payload);
    if (!transcript) throw new Error("Caption json parsed but transcript empty");
    return transcript;
  }

  const transcript = transcriptFromXml(raw);
  if (!transcript) throw new Error("Caption xml parsed but transcript empty");
  return transcript;
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
