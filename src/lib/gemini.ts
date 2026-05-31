import type { Env } from "../types";
import { toSafeErrorMessage } from "./utils";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

function modelName(env: Env): string {
  return env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";
}

function requireApiKey(env: Env): string {
  if (!env.GEMINI_API_KEY) {
    throw new Error("缺少 GEMINI_API_KEY，请先通过 wrangler secret 设置");
  }
  return env.GEMINI_API_KEY;
}

function extractTextFromChunk(payload: any): string {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
    .join("");
}

function extractJsonCandidate(payload: any): string {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
    .join("")
    .trim();
}

function sanitizeJsonText(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) return fenced[1].trim();
  return raw.trim();
}

function drainSseBlocks(buffer: string, flush = false): {
  blocks: string[];
  rest: string;
} {
  const blocks: string[] = [];
  const separator = /\r?\n\r?\n/g;
  let start = 0;
  let match: RegExpExecArray | null;

  while ((match = separator.exec(buffer))) {
    blocks.push(buffer.slice(start, match.index));
    start = separator.lastIndex;
  }

  const rest = buffer.slice(start);
  if (flush && rest.trim()) {
    blocks.push(rest);
    return { blocks, rest: "" };
  }

  return { blocks, rest };
}

function extractSseData(eventBlock: string): string {
  return eventBlock
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
}

export async function streamArticleHtml(params: {
  prompt: string;
  env: Env;
  onChunk: (chunk: string) => Promise<void> | void;
}): Promise<string> {
  const key = requireApiKey(params.env);
  const model = modelName(params.env);
  const url = `${GEMINI_BASE}/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      generationConfig: {
        temperature: 0.6,
        topP: 0.9
      },
      contents: [
        {
          role: "user",
          parts: [{ text: params.prompt }]
        }
      ]
    })
  });

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    throw new Error(`Gemini 流式请求失败: ${response.status} ${text.slice(0, 300)}`);
  }

  const reader = response.body
    .pipeThrough(new TextDecoderStream())
    .getReader();

  let articleHtml = "";
  let buffer = "";

  const processBlocks = async (blocks: string[]) => {
    for (const eventBlock of blocks) {
      const data = extractSseData(eventBlock);
      if (!data || data === "[DONE]") continue;

      try {
        const payload = JSON.parse(data);
        const chunk = extractTextFromChunk(payload);
        if (!chunk) continue;
        articleHtml += chunk;
        await params.onChunk(chunk);
      } catch {
        // Ignore malformed SSE events and continue consuming later chunks.
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    buffer += value;

    const drained = drainSseBlocks(buffer);
    buffer = drained.rest;
    await processBlocks(drained.blocks);
  }

  await processBlocks(drainSseBlocks(buffer, true).blocks);

  if (!articleHtml.trim()) {
    throw new Error("Gemini 已结束响应，但未返回文章内容，请重试");
  }

  return articleHtml;
}

export async function generateFiveW1HJson(params: {
  prompt: string;
  env: Env;
}): Promise<Record<string, unknown>> {
  const key = requireApiKey(params.env);
  const model = modelName(params.env);
  const url = `${GEMINI_BASE}/models/${model}:generateContent?key=${encodeURIComponent(key)}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json"
      },
      contents: [
        {
          role: "user",
          parts: [{ text: params.prompt }]
        }
      ]
    })
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Gemini 5W1H 请求失败: ${response.status} ${text.slice(0, 300)}`);
  }

  const payload = await response.json();
  const text = sanitizeJsonText(extractJsonCandidate(payload));

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`5W1H JSON 解析失败: ${toSafeErrorMessage(error)}; raw=${text.slice(0, 200)}`);
  }
}
