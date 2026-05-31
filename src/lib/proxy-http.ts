import { connect } from "cloudflare:sockets";
import type { Env } from "../types";
import { textDecoder, textEncoder } from "./utils";

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

function proxyAuthHeader(env: Env): string {
  if (!env.WEBSHARE_PROXY_USERNAME || !env.WEBSHARE_PROXY_PASSWORD) return "";
  return `Proxy-Authorization: Basic ${btoa(`${env.WEBSHARE_PROXY_USERNAME}:${env.WEBSHARE_PROXY_PASSWORD}`)}\r\n`;
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

function findHeaderEnd(buf: Uint8Array): number {
  for (let i = 0; i <= buf.length - 4; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) {
      return i;
    }
  }
  return -1;
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
      if (headerEnd >= 0) {
        const headBytes = combined.slice(0, headerEnd);
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
  if (splitAt < 0) {
    return new Response("Invalid proxy response", { status: 502 });
  }

  const headerBytes = raw.slice(0, splitAt);
  const bodyBytes = raw.slice(splitAt + 4);
  const headerText = textDecoder.decode(headerBytes);
  const lines = headerText.split("\r\n");
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

async function fetchViaProxyHttp(url: URL, env: Env, timeoutMs: number): Promise<Response> {
  const { hostname, port } = getProxyTarget(env);
  const socket = connect({ hostname, port });

  const request =
    `GET ${url.toString()} HTTP/1.1\r\n` +
    `Host: ${url.host}\r\n` +
    `${proxyAuthHeader(env)}` +
    "Accept: text/html,application/json,text/plain,*/*\r\n" +
    "User-Agent: Mozilla/5.0 (compatible; article-generator/1.0)\r\n" +
    "Connection: close\r\n\r\n";

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

async function fetchViaProxyHttps(url: URL, env: Env, timeoutMs: number): Promise<Response> {
  const { hostname, port } = getProxyTarget(env);
  const socket = connect({ hostname, port }, { secureTransport: "starttls", allowHalfOpen: false });

  const connectReq =
    `CONNECT ${url.hostname}:${url.port || "443"} HTTP/1.1\r\n` +
    `Host: ${url.hostname}:${url.port || "443"}\r\n` +
    `${proxyAuthHeader(env)}` +
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
  const requestPath = `${url.pathname}${url.search}`;
  const req =
    `GET ${requestPath || "/"} HTTP/1.1\r\n` +
    `Host: ${url.host}\r\n` +
    "Accept: text/html,application/json,text/plain,*/*\r\n" +
    "User-Agent: Mozilla/5.0 (compatible; article-generator/1.0)\r\n" +
    "Connection: close\r\n\r\n";

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

export async function fetchViaWebshareProxy(url: URL, env: Env, timeoutMs = 10000): Promise<Response> {
  if (url.protocol === "https:") {
    return fetchViaProxyHttps(url, env, timeoutMs);
  }
  return fetchViaProxyHttp(url, env, timeoutMs);
}

function directFetch(url: URL): Promise<Response> {
  return fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; article-generator/1.0)"
    }
  });
}

export async function fetchWithOptionalProxy(url: URL, env: Env, timeoutMs = 10000): Promise<Response> {
  if (!isProxyEnabled(env)) {
    return directFetch(url);
  }

  let directError: unknown = null;
  let directResponse: Response | null = null;

  try {
    directResponse = await directFetch(url);
    if (directResponse.ok) return directResponse;
  } catch (error) {
    directError = error;
  }

  try {
    const proxyResponse = await fetchViaWebshareProxy(url, env, timeoutMs);
    if (proxyResponse.ok) return proxyResponse;

    if (directResponse) return directResponse;
    return proxyResponse;
  } catch {
    if (directResponse) return directResponse;
    if (directError) throw directError;
    return directFetch(url);
  }
}
