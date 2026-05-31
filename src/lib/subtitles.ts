import type { Env, SubtitleSource } from "../types";
import { extractVideoId, toSafeErrorMessage } from "./utils";
import { fetchWithOptionalProxy, listProxyTargets, type ProxyTarget } from "./proxy-http";

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

interface LegacyTrack {
  langCode: string;
  name?: string;
  kind?: string;
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

function extractInitialPlayerResponse(watchHtml: string): any | null {
  const candidates = [
    "ytInitialPlayerResponse = ",
    "var ytInitialPlayerResponse = ",
    "window[\"ytInitialPlayerResponse\"] = "
  ];

  for (const token of candidates) {
    const raw = extractBalancedJson(watchHtml, token);
    if (!raw) continue;
    try {
      return JSON.parse(raw);
    } catch {
      // continue
    }
  }
  return null;
}

function extractJsonString(watchHtml: string, key: string): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = watchHtml.match(new RegExp(`"${escapedKey}":"([^"]+)"`));
  return match?.[1] ? decodeEscapedJsonString(match[1]) : null;
}

async function fetchInnertubePlayerResponse(
  videoId: string,
  watchHtml: string,
  env: Env,
  timeoutMs: number,
  proxySessionId: string,
  headers: Record<string, string>,
  proxyTarget: ProxyTarget
): Promise<any | null> {
  const apiKey = extractJsonString(watchHtml, "INNERTUBE_API_KEY");
  const clientVersion = extractJsonString(watchHtml, "INNERTUBE_CLIENT_VERSION");
  if (!apiKey || !clientVersion) return null;

  const visitorData = extractJsonString(watchHtml, "VISITOR_DATA");
  const url = new URL("https://www.youtube.com/youtubei/v1/player");
  url.searchParams.set("key", apiKey);

  const clients: Array<Record<string, string | number>> = [
    {
      clientName: "ANDROID",
      clientVersion: "20.10.38",
      androidSdkVersion: 30,
      hl: "en",
      gl: "US",
      userAgent: "com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip",
      osName: "Android",
      osVersion: "14"
    },
    {
      clientName: "WEB",
      clientVersion,
      hl: "en",
      gl: "US",
      ...(visitorData ? { visitorData } : {})
    }
  ];

  let lastResponse: any | null = null;
  const diagnostics: string[] = [];
  for (const client of clients) {
    const isAndroid = client.clientName === "ANDROID";
    const response = await fetchWithOptionalProxy(url, env, timeoutMs, {
      proxySessionId,
      proxyTarget,
      method: "POST",
      body: JSON.stringify({
        context: { client },
        videoId,
        contentCheckOk: true,
        racyCheckOk: true
      }),
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "User-Agent": typeof client.userAgent === "string" ? client.userAgent : "Mozilla/5.0",
        "X-YouTube-Client-Name": isAndroid ? "3" : "1",
        "X-YouTube-Client-Version": String(client.clientVersion)
      }
    });
    if (!response.ok) {
      diagnostics.push(`${client.clientName}:http-${response.status}`);
      continue;
    }

    const diagnosticResponse = response.clone();
    try {
      const payload: any = await response.json();
      lastResponse = payload;
      diagnostics.push(`${client.clientName}:${summarizePlayerResponse(payload)}`);
      const tracks = payload?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (Array.isArray(tracks) && tracks.length) {
        return payload;
      }
    } catch {
      const raw = await diagnosticResponse.text();
      diagnostics.push(
        `${client.clientName}:invalid-json, ` +
        `ce=${diagnosticResponse.headers.get("content-encoding") || ""}, ` +
        `ct=${diagnosticResponse.headers.get("content-type") || ""}, ` +
        `body=${preview(raw, 100)}`
      );
    }
  }

  return {
    ...(lastResponse || {}),
    _clientDiagnostics: diagnostics.join(" | ")
  };
}

function summarizePlayerResponse(playerResponse: any): string {
  const status = playerResponse?.playabilityStatus?.status || "missing";
  const reason = playerResponse?.playabilityStatus?.reason || "";
  const clients = playerResponse?._clientDiagnostics ? `, clients=${playerResponse._clientDiagnostics}` : "";
  return `status=${status}, reason=${reason}${clients}`.slice(0, 360);
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

function rankLegacyTracks(tracks: LegacyTrack[]): LegacyTrack[] {
  const preferred = ["zh-Hans", "zh-CN", "zh-TW", "zh-Hant", "zh", "en"];
  const rank = (track: LegacyTrack) => {
    const code = (track.langCode || "").toLowerCase();
    const idx = preferred.findIndex((p) => p.toLowerCase() === code);
    return idx >= 0 ? idx : 999;
  };
  return [...tracks].sort((a, b) => rank(a) - rank(b));
}

function parseLegacyTrackList(xml: string): LegacyTrack[] {
  const matches = Array.from(xml.matchAll(/<track\s+([^>]+?)\s*\/?>/g));
  const tracks: LegacyTrack[] = [];

  for (const m of matches) {
    const attrs = m[1] || "";
    const langCode = attrs.match(/lang_code="([^"]+)"/)?.[1];
    if (!langCode) continue;
    const name = attrs.match(/name="([^"]*)"/)?.[1];
    const kind = attrs.match(/kind="([^"]*)"/)?.[1];
    tracks.push({ langCode, name, kind });
  }
  return tracks;
}

async function fetchLegacyTrackListByUrl(
  url: URL,
  env: Env,
  timeoutMs: number,
  proxySessionId: string,
  headers: Record<string, string>
): Promise<LegacyTrack[]> {
  const response = await fetchWithOptionalProxy(url, env, timeoutMs, { proxySessionId, headers });
  if (!response.ok) return [];
  const xml = await response.text();
  if (!xml.trim()) return [];
  return parseLegacyTrackList(xml);
}

async function fetchLegacyTranscriptNoTlsFirst(
  videoId: string,
  env: Env,
  timeoutMs: number,
  proxySessionId: string
): Promise<string | null> {
  const headers: Record<string, string> = {
    Referer: `https://www.youtube.com/watch?v=${videoId}`,
    Origin: "https://www.youtube.com"
  };

  const listUrls = [
    new URL(`http://video.google.com/timedtext?type=list&v=${encodeURIComponent(videoId)}`),
    new URL(`http://www.youtube.com/api/timedtext?type=list&v=${encodeURIComponent(videoId)}`)
  ];

  let legacyTracks: LegacyTrack[] = [];
  for (const listUrl of listUrls) {
    const found = await fetchLegacyTrackListByUrl(listUrl, env, timeoutMs, proxySessionId, headers);
    if (found.length) {
      legacyTracks = found;
      break;
    }
  }

  if (!legacyTracks.length) return null;

  const ranked = rankLegacyTracks(legacyTracks);
  const baseHosts = ["video.google.com", "www.youtube.com"];

  for (const track of ranked) {
    for (const host of baseHosts) {
      const tUrl = new URL(`http://${host}/timedtext`);
      if (host === "www.youtube.com") {
        tUrl.pathname = "/api/timedtext";
      }
      tUrl.searchParams.set("v", videoId);
      tUrl.searchParams.set("lang", track.langCode);
      if (track.name) tUrl.searchParams.set("name", track.name);
      if (track.kind) tUrl.searchParams.set("kind", track.kind);
      tUrl.searchParams.set("fmt", "srv3");
      tUrl.searchParams.set("track", "asr");

      try {
        const transcript = await fetchTrackOnce(tUrl, env, timeoutMs, proxySessionId, headers);
        if (transcript.trim()) return transcript;
      } catch {
        // continue
      }
    }
  }

  return null;
}

async function fetchTrackOnce(
  url: URL,
  env: Env,
  timeoutMs: number,
  proxySessionId: string,
  headers: Record<string, string>,
  proxyTarget?: ProxyTarget
): Promise<string> {
  const response = await fetchWithOptionalProxy(url, env, timeoutMs, { proxySessionId, headers, proxyTarget });
  if (!response.ok) {
    const bodyPreview = preview(await response.text());
    throw new Error(`Caption fetch failed: ${response.status}, body=${bodyPreview}`);
  }

  const raw = await response.text();
  if (!raw.trim()) {
    const ct = response.headers.get("content-type") || "";
    const cl = response.headers.get("content-length") || "";
    throw new Error(`Caption response empty, status=${response.status}, ct=${ct}, cl=${cl}`);
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
    copied.searchParams.set("xorb", "2");
    copied.searchParams.set("xobt", "3");
    copied.searchParams.set("xovt", "3");
  }
  return copied;
}

function buildCookieHeaderFromSetCookie(setCookieRaw: string | null): string | null {
  if (!setCookieRaw) return null;
  const items = setCookieRaw
    .split(/,(?=[^;,]+=)/)
    .map((item) => item.trim())
    .map((item) => item.split(";")[0]?.trim())
    .filter(Boolean);

  if (!items.length) return null;
  return items.join("; ");
}

async function fetchTrackTranscript(
  track: CaptionTrack,
  env: Env,
  timeoutMs: number,
  poToken: string | null,
  proxySessionId: string,
  headers: Record<string, string>,
  proxyTarget: ProxyTarget
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
      const transcript = await fetchTrackOnce(target, env, timeoutMs, proxySessionId, headers, proxyTarget);
      if (transcript.trim()) return transcript;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("track transcript fetch failed");
}

async function fetchTranscriptFromWatch(
  videoId: string,
  env: Env,
  timeoutMs: number,
  proxySessionId: string,
  proxyTarget: ProxyTarget
): Promise<string> {
  const watchUrl = new URL(`https://www.youtube.com/watch?v=${videoId}`);
  const watchResp = await fetchWithOptionalProxy(watchUrl, env, timeoutMs, { proxySessionId, proxyTarget });
  if (!watchResp.ok) {
    const bodyPreview = preview(await watchResp.text(), 200);
    throw new Error(`YouTube watch page fetch failed: ${watchResp.status}, body=${bodyPreview}`);
  }

  const cookieHeader = buildCookieHeaderFromSetCookie(watchResp.headers.get("set-cookie"));
  const requestHeaders: Record<string, string> = {
    Referer: watchUrl.toString(),
    Origin: "https://www.youtube.com"
  };
  if (cookieHeader) {
    requestHeaders.Cookie = cookieHeader;
  }

  const watchHtml = await watchResp.text();
  const embeddedPlayerResponse = extractInitialPlayerResponse(watchHtml);
  const embeddedTracks = embeddedPlayerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  const playerResponse =
    Array.isArray(embeddedTracks) && embeddedTracks.length
      ? embeddedPlayerResponse
      : await fetchInnertubePlayerResponse(
      videoId,
      watchHtml,
      env,
      timeoutMs,
      proxySessionId,
      requestHeaders,
      proxyTarget
      );
  const fallbackCaptionsRaw =
    extractBalancedJson(watchHtml, '"captions":') ||
    extractBalancedJson(watchHtml, '"captions": ');
  const fallbackCaptions = fallbackCaptionsRaw ? JSON.parse(fallbackCaptionsRaw) : null;
  const captionTracks =
    playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks ||
    fallbackCaptions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(captionTracks) || captionTracks.length === 0) {
    throw new Error(
      `No caption tracks found on video; ` +
      `apiKey=${Boolean(extractJsonString(watchHtml, "INNERTUBE_API_KEY"))}, ` +
      `clientVersion=${Boolean(extractJsonString(watchHtml, "INNERTUBE_CLIENT_VERSION"))}, ` +
      `${summarizePlayerResponse(playerResponse)}; watch=${preview(watchHtml, 160)}`
    );
  }
  const poToken = extractPoToken(watchHtml);

  const ordered = rankTracks(captionTracks as CaptionTrack[]);
  const errors: string[] = [];

  for (const track of ordered) {
    try {
      const transcript = await fetchTrackTranscript(
        track,
        env,
        timeoutMs,
        poToken,
        proxySessionId,
        requestHeaders,
        proxyTarget
      );
      if (transcript.trim()) return transcript;
      errors.push(`lang=${track.languageCode || "unknown"}: empty transcript`);
    } catch (error) {
      errors.push(`lang=${track.languageCode || "unknown"}: ${toSafeErrorMessage(error)}`);
    }
  }

  try {
    const legacyTrackListUrl = new URL("https://video.google.com/timedtext");
    legacyTrackListUrl.searchParams.set("type", "list");
    legacyTrackListUrl.searchParams.set("v", videoId);
    const listResp = await fetchWithOptionalProxy(legacyTrackListUrl, env, timeoutMs, {
      proxySessionId,
      proxyTarget,
      headers: requestHeaders
    });
    if (listResp.ok) {
      const xml = await listResp.text();
      const legacyTracks = rankLegacyTracks(parseLegacyTrackList(xml));
      for (const track of legacyTracks) {
        const tUrl = new URL("https://video.google.com/timedtext");
        tUrl.searchParams.set("v", videoId);
        tUrl.searchParams.set("lang", track.langCode);
        if (track.name) tUrl.searchParams.set("name", track.name);
        if (track.kind) tUrl.searchParams.set("kind", track.kind);
        tUrl.searchParams.set("fmt", "srv3");
        try {
          const legacy = await fetchTrackOnce(tUrl, env, timeoutMs, proxySessionId, requestHeaders, proxyTarget);
          if (legacy.trim()) return legacy;
        } catch (error) {
          errors.push(`legacy-${track.langCode}: ${toSafeErrorMessage(error)}`);
        }
      }
    } else {
      errors.push(`legacy-list-http-${listResp.status}`);
    }
  } catch (error) {
    errors.push(`legacy-list-error: ${toSafeErrorMessage(error)}`);
  }

  throw new Error(`All caption tracks failed. details=${errors.slice(0, 4).join(" | ")}`);
}

async function fetchYoutubeTranscriptByVideoId(videoId: string, env: Env): Promise<string> {
  const rawTimeout = Number.parseInt(env.YOUTUBE_FETCH_TIMEOUT_MS || "12000", 10);
  const timeoutMs = Number.isFinite(rawTimeout) ? Math.max(10000, rawTimeout) : 12000;
  const proxySessionId = String(Math.floor(100000 + Math.random() * 900000));

  const noTlsTranscript = await fetchLegacyTranscriptNoTlsFirst(videoId, env, timeoutMs, proxySessionId);
  if (noTlsTranscript?.trim()) {
    return noTlsTranscript;
  }

  const targets = listProxyTargets(env);
  const errors: string[] = [];
  for (const target of targets) {
    try {
      return await fetchTranscriptFromWatch(videoId, env, timeoutMs, proxySessionId, target);
    } catch (error) {
      errors.push(`${target.hostname}:${target.port} -> ${toSafeErrorMessage(error)}`);
    }
  }

  if (errors.length && errors.every((error) => error.includes("Sign in to confirm you’re not a bot"))) {
    throw new Error(
      `YouTube 已将全部 ${errors.length} 个 Webshare 代理节点识别为 bot 流量。` +
      "请在 Webshare 替换代理节点，或在页面中填写字幕回退文本。"
    );
  }

  throw new Error(`All YouTube proxy targets failed. details=${errors.join(" | ")}`);
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
