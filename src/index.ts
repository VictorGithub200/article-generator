import type { Env, GenerateRequest } from "./types";
import { randomId, jsonResponse, toSafeErrorMessage, textEncoder } from "./lib/utils";
import { resolveTranscript } from "./lib/subtitles";
import { buildArticlePrompt } from "./prompts/article";
import { buildFiveW1HPrompt, normalizeFiveW1H } from "./prompts/fivew1h";
import { streamArticleHtml, generateFiveW1HJson } from "./lib/gemini";
import { extractSections } from "./lib/sections";
import { ContextStoreDO, loadContext, saveContext } from "./context-store-do";

function sseEvent(name: string, payload: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

async function handleGenerate(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as GenerateRequest;

  if (!body.youtubeUrl?.trim()) {
    return jsonResponse({ error: "youtubeUrl 不能为空" }, 400);
  }

  const transcriptResult = await resolveTranscript(body.youtubeUrl.trim(), body.subtitleInput, env);
  const contextId = randomId("ctx");
  const createdAt = new Date().toISOString();

  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();

  const writeEvent = async (name: string, payload: unknown) => {
    await writer.write(textEncoder.encode(sseEvent(name, payload)));
  };

  void (async () => {
    try {
      await writeEvent("meta", {
        contextId,
        createdAt,
        subtitleSource: transcriptResult.source,
        subtitleDetail: transcriptResult.detail,
        videoId: transcriptResult.videoId
      });

      const prompt = buildArticlePrompt({
        transcript: transcriptResult.transcript,
        youtubeUrl: body.youtubeUrl,
        guidance: body.guidance
      });

      const articleHtml = await streamArticleHtml({
        prompt,
        env,
        onChunk: async (chunk) => {
          await writeEvent("chunk", { text: chunk });
        }
      });

      const sections = extractSections(articleHtml);
      await saveContext(env.CONTEXT_STORE, {
        contextId,
        createdAt,
        youtubeUrl: body.youtubeUrl,
        videoId: transcriptResult.videoId,
        subtitleSource: transcriptResult.source,
        transcript: transcriptResult.transcript,
        articleHtml,
        sections
      });

      await writeEvent("done", {
        contextId,
        sections
      });
    } catch (error) {
      await writeEvent("error", {
        message: toSafeErrorMessage(error)
      });
    } finally {
      await writer.close();
    }
  })();

  return new Response(stream.readable, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive"
    }
  });
}

async function handleFiveW1H(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as {
    contextId?: string;
    sectionId?: string;
  };

  if (!body.contextId || !body.sectionId) {
    return jsonResponse({ error: "contextId 与 sectionId 必填" }, 400);
  }

  const context = await loadContext(env.CONTEXT_STORE, body.contextId);
  if (!context) {
    return jsonResponse({ error: "上下文不存在或已过期，请重新生成文章" }, 404);
  }

  const section = context.sections.find((item) => item.id === body.sectionId);
  if (!section) {
    return jsonResponse({ error: "章节不存在" }, 404);
  }

  const prompt = buildFiveW1HPrompt({
    fullArticle: context.articleHtml,
    sectionTitle: section.title,
    sectionExcerpt: section.excerpt
  });

  const raw = await generateFiveW1HJson({ prompt, env });
  const normalized = normalizeFiveW1H(raw);

  return jsonResponse({
    contextId: context.contextId,
    sectionId: section.id,
    sectionTitle: section.title,
    summary: normalized
  });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          allow: "GET, POST, OPTIONS"
        }
      });
    }

    try {
      if (request.method === "POST" && url.pathname === "/api/generate") {
        return await handleGenerate(request, env);
      }

      if (request.method === "POST" && url.pathname === "/api/5w1h") {
        return await handleFiveW1H(request, env);
      }

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, date: new Date().toISOString() });
      }

      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        return env.ASSETS.fetch(new Request(`${url.origin}/index.html`, request));
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      return jsonResponse({
        error: toSafeErrorMessage(error)
      }, 500);
    }
  }
} satisfies ExportedHandler<Env>;

export { ContextStoreDO };
