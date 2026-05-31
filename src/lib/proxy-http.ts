import { connect } from "cloudflare:sockets";
import type { Env } from "../types";
import { textDecoder, textEncoder } from "./utils";
interface ProxyFetchOptions {
  proxySessionId?: string;
  headers?: Record<string, string>;
}

function isProxyEnabled(env: Env): boolean {
  const flag = (env.WEBSHARE_PROXY_ENABLED || "").trim().toLowerCase();
  if (flag === "false" || flag === "0" || flag === "off") return false;
  return Boolean((env.WEBSHARE_PROXY_HOST || "").trim());
}

function getProxyTarget(env: Env): { hostname: string; port: number } {
  const rawHost = (env.WEBSHARE_PROXY_HOST || "").trim();
  if (!rawHost) {
    throw new Error("Proxy host missing");
  }

  let hostname = rawHost;
  let port = Number.parseInt(env.WEBSHARE_PROXY_PORT || "80", 10);

  if (rawHost.includes(":") && !rawHost.startsWith("[")) {
    const [host, maybePort] = rawHost.split(":");
    if (host && maybePort && /^\d+$/.test(maybePort)) {
      hostname = host;
      port = Number.parseInt(maybePort, 10);
    }
  }

  return { hostname, port };
}

function proxyAuthHeader(env: Env, options?: ProxyFetchOptions): string {
  if (!env.WEBSHARE_PROXY_USERNAME || !env.WEBSHARE_PROXY_PASSWORD) return "";

  let username = env.WEBSHARE_PROXY_USERNAME;
  const sessionId = options?.proxySessionId?.trim();
  if (sessionId && !username.endsWith("-rotate")) {
    const hasNumericSession = /-\d+$/.test(username);
    if (!hasNumericSession) {
      username = `${username}-${sessionId}`;
    }
  }

  return `Proxy-Authorization: Basic ${btoa(`${username}:${env.WEBSHARE_PROXY_PASSWORD}`)}\r\n`;
}

function isProxyOnly(env: Env): boolean {
  const flag = (env.WEBSHARE_PROXY_ONLY || "").trim().toLowerCase();
  return flag === "true" || flag === "1" || flag === "on";
}

function requestHeaders(url: URL, headers?: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = {
    Host: url.host,
    Accept: "text/html,application/json,text/plain,*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": "Mozilla/5.0 (compatible; article-generator/1.0)",
    Connection: "close",
    ...headers
  };
  return merged;
}

function headersToRaw(headers: Record<string, string>): string {
  return Object.entries(headers)
    .filter(([, value]) => value != null && String(value).length > 0)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\r\n");
}

function mergeChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, part) => sum + part.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of chunks) {
    merged.set(part, offset);
    offset += part.length;
  }
  return merged;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
  }

  return mergeChunks(chunks);
}

function findHeaderEnd(buf: Uint8Array): { index: number; size: number } | null {
  for (let i = 0; i <= buf.length - 4; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) {
      return { index: i, size: 4 };
    }
  }
  for (let i = 0; i <= buf.length - 2; i++) {
    if (buf[i] === 10 && buf[i + 1] === 10) {
      return { index: i, size: 2 };
    }
  }
  return null;
}

async function readHead(stream: ReadableStream<Uint8Array>, timeoutMs: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];

  const readPromise = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      chunks.push(value);
      const combined = mergeChunks(chunks);
      const headerEnd = findHeaderEnd(combined);
      if (headerEnd) {
        const headBytes = combined.slice(0, headerEnd.index);
        return textDecoder.decode(headBytes);
      }
    }

    return textDecoder.decode(mergeChunks(chunks));
  })();

  try {
    return await Promise.race([
      readPromise,
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error(`Proxy head read timeout after ${timeoutMs}ms`)), timeoutMs)
      )
    ]);
  } finally {
    reader.releaseLock();
  }
}

function parseConnectStatus(head: string): { status: number; firstLine: string } {
  const firstLine = head.split("\r\n")[0] || "";
  const m = firstLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/);
  return {
    status: m ? Number.parseInt(m[1], 10) : 0,
    firstLine
  };
}

function maybeDecodeChunked(body: Uint8Array, headers: Headers): Uint8Array {
  const transferEncoding = headers.get("transfer-encoding")?.toLowerCase() || "";
  if (!transferEncoding.includes("chunked")) return body;

  const text = textDecoder.decode(body);
  let cursor = 0;
  const out: Uint8Array[] = [];

  while (cursor < text.length) {
    const lineEnd = text.indexOf("\r\n", cursor);
    if (lineEnd < 0) break;

    const sizeHex = text.slice(cursor, lineEnd).trim();
    const size = Number.parseInt(sizeHex, 16);
    if (!Number.isFinite(size) || size < 0) break;
    cursor = lineEnd + 2;

    if (size === 0) break;

    const chunkText = text.slice(cursor, cursor + size);
    out.push(textEncoder.encode(chunkText));
    cursor += size + 2;
  }

  if (!out.length) return body;
  return mergeChunks(out);
}

function parseRawHttp(raw: Uint8Array): Response {
  const splitAt = findHeaderEnd(raw);
  if (!splitAt) {
    const preview = textDecoder.decode(raw.slice(0, Math.min(raw.length, 160))).replace(/\s+/g, " ");
    return new Response(`Invalid proxy response: raw_len=${raw.length}, preview=${preview}`, { status: 502 });
  }

  const headerBytes = raw.slice(0, splitAt.index);
  const bodyBytes = raw.slice(splitAt.index + splitAt.size);
  const headerText = textDecoder.decode(headerBytes);
  const lines = headerText.split(/\r?\n/);
  const statusLine = lines.shift() || "HTTP/1.1 502 Bad Gateway";
  const statusMatch = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/);
  const status = statusMatch ? Number.parseInt(statusMatch[1], 10) : 502;

  const headers = new Headers();
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) headers.append(key, value);
  }

  const decodedBody = maybeDecodeChunked(bodyBytes, headers);
  headers.delete("transfer-encoding");
  headers.set("content-length", String(decodedBody.length));
  const bodyBuffer = decodedBody.buffer.slice(
    decodedBody.byteOffset,
    decodedBody.byteOffset + decodedBody.byteLength
  ) as ArrayBuffer;
  return new Response(bodyBuffer, { status, headers });
}

async function fetchViaProxyHttp(
  url: URL,
  env: Env,
  timeoutMs: number,
  options?: ProxyFetchOptions
): Promise<Response> {
  const { hostname, port } = getProxyTarget(env);
  const socket = connect({ hostname, port });
  await socket.opened;

  const headers = requestHeaders(url, options?.headers);
  const request =
    `GET ${url.toString()} HTTP/1.1\r\n` +
    `${proxyAuthHeader(env, options)}` +
    `${headersToRaw(headers)}\r\n\r\n`;

  const writer = socket.writable.getWriter();
  await writer.write(textEncoder.encode(request));
  await writer.close();

  const raw = await Promise.race([
    readAll(socket.readable),
    new Promise<Uint8Array>((_, reject) =>
      setTimeout(() => reject(new Error(`Proxy request timeout after ${timeoutMs}ms`)), timeoutMs)
    )
  ]);

  await socket.close();
  return parseRawHttp(raw);
}

async function fetchViaProxyHttps(
  url: URL,
  env: Env,
  timeoutMs: number,
  options?: ProxyFetchOptions
): Promise<Response> {
  const { hostname, port } = getProxyTarget(env);
  const socket = connect({ hostname, port }, { secureTransport: "starttls", allowHalfOpen: false });
  await socket.opened;

  const connectReq =
    `CONNECT ${url.hostname}:${url.port || "443"} HTTP/1.1\r\n` +
    `Host: ${url.hostname}:${url.port || "443"}\r\n` +
    `${proxyAuthHeader(env, options)}` +
    "Proxy-Connection: Keep-Alive\r\n\r\n";

  const preWriter = socket.writable.getWriter();
  await preWriter.write(textEncoder.encode(connectReq));
  preWriter.releaseLock();

  const head = await readHead(socket.readable, timeoutMs);
  const { status, firstLine } = parseConnectStatus(head);
  if (status !== 200) {
    await socket.close();
    throw new Error(`Proxy CONNECT failed: ${firstLine || "unknown"}`);
  }

  const tlsSocket = socket.startTls();
  await tlsSocket.opened;
  const requestPath = `${url.pathname}${url.search}`;
  const headers = requestHeaders(url, options?.headers);
  const req =
    `GET ${requestPath || "/"} HTTP/1.1\r\n` +
    `${headersToRaw(headers)}\r\n\r\n`;

  const writer = tlsSocket.writable.getWriter();
  await writer.write(textEncoder.encode(req));
  await writer.close();

  const raw = await Promise.race([
    readAll(tlsSocket.readable),
    new Promise<Uint8Array>((_, reject) =>
      setTimeout(() => reject(new Error(`Proxy HTTPS request timeout after ${timeoutMs}ms`)), timeoutMs)
    )
  ]);

  await tlsSocket.close();
  return parseRawHttp(raw);
}

async function fetchViaProxyHttpsFallback(
  url: URL,
  env: Env,
  timeoutMs: number,
  options?: ProxyFetchOptions
): Promise<Response> {
  return fetchViaProxyHttp(url, env, timeoutMs, options);
}

export async function fetchViaWebshareProxy(
  url: URL,
  env: Env,
  timeoutMs = 10000,
  options?: ProxyFetchOptions
): Promise<Response> {
  if (url.protocol === "https:") {
    try {
      return await fetchViaProxyHttps(url, env, timeoutMs, options);
    } catch {
      return fetchViaProxyHttpsFallback(url, env, timeoutMs, options);
    }
  }
  return fetchViaProxyHttp(url, env, timeoutMs, options);
}

function directFetch(url: URL, options?: ProxyFetchOptions): Promise<Response> {
  const headers = requestHeaders(url, options?.headers);
  return fetch(url, {
    headers
  });
}

export async function fetchWithOptionalProxy(
  url: URL,
  env: Env,
  timeoutMs = 10000,
  options?: ProxyFetchOptions
): Promise<Response> {
  if (!isProxyEnabled(env)) {
    return directFetch(url, options);
  }

  let proxyError: unknown = null;
  let proxyResponse: Response | null = null;

  try {
    proxyResponse = await fetchViaWebshareProxy(url, env, timeoutMs, options);
    if (proxyResponse.ok) return proxyResponse;
  } catch (error) {
    proxyError = error;
  }

  if (isProxyOnly(env)) {
    if (proxyResponse) return proxyResponse;
    if (proxyError) throw proxyError;
    throw new Error("Proxy-only mode enabled, but proxy request failed");
  }

  let directError: unknown = null;
  let directResponse: Response | null = null;
  try {
    directResponse = await directFetch(url, options);
    if (directResponse.ok) return directResponse;
  } catch (error) {
    directError = error;
  }

  if (proxyResponse) return proxyResponse;
  if (directResponse) return directResponse;
  if (proxyError) throw proxyError;
  if (directError) throw directError;
  return directFetch(url, options);
}
