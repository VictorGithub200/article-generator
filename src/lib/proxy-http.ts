import { connect } from "cloudflare:sockets";
import type { Env } from "../types";
import { textDecoder, textEncoder } from "./utils";

function isProxyEnabled(env: Env): boolean {
  return env.WEBSHARE_PROXY_ENABLED === "true" && Boolean(env.WEBSHARE_PROXY_HOST);
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
  const total = out.reduce((sum, part) => sum + part.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of out) {
    merged.set(part, offset);
    offset += part.length;
  }
  return merged;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    total += value.length;
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function parseRawHttp(raw: Uint8Array): Response {
  const marker = textEncoder.encode("\r\n\r\n");
  let splitAt = -1;
  for (let i = 0; i <= raw.length - marker.length; i++) {
    if (
      raw[i] === marker[0] &&
      raw[i + 1] === marker[1] &&
      raw[i + 2] === marker[2] &&
      raw[i + 3] === marker[3]
    ) {
      splitAt = i;
      break;
    }
  }
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

export async function fetchViaWebshareProxy(url: URL, env: Env, timeoutMs = 10000): Promise<Response> {
  const host = env.WEBSHARE_PROXY_HOST;
  if (!host) {
    throw new Error("Proxy host missing");
  }

  const port = Number.parseInt(env.WEBSHARE_PROXY_PORT || "80", 10);
  const socket = connect({ hostname: host, port });

  const auth = env.WEBSHARE_PROXY_USERNAME && env.WEBSHARE_PROXY_PASSWORD
    ? `Proxy-Authorization: Basic ${btoa(`${env.WEBSHARE_PROXY_USERNAME}:${env.WEBSHARE_PROXY_PASSWORD}`)}\r\n`
    : "";

  const request =
    `GET ${url.toString()} HTTP/1.1\r\n` +
    `Host: ${url.host}\r\n` +
    `${auth}` +
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

export async function fetchWithOptionalProxy(url: URL, env: Env, timeoutMs = 10000): Promise<Response> {
  if (!isProxyEnabled(env)) {
    return fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; article-generator/1.0)"
      }
    });
  }

  try {
    return await fetchViaWebshareProxy(url, env, timeoutMs);
  } catch {
    return fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; article-generator/1.0)"
      }
    });
  }
}
