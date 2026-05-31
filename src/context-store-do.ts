import { DurableObject } from "cloudflare:workers";
import type { GenerateContext } from "./types";

interface PutPayload {
  context: GenerateContext;
}

export class ContextStoreDO extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/put") {
      const body = (await request.json()) as PutPayload;
      await this.ctx.storage.put("context", body.context);
      await this.ctx.storage.put("updatedAt", new Date().toISOString());
      return new Response("ok");
    }

    if (request.method === "GET" && url.pathname === "/get") {
      const context = (await this.ctx.storage.get("context")) as GenerateContext | undefined;
      if (!context) {
        return new Response("not found", { status: 404 });
      }
      return Response.json(context);
    }

    return new Response("Not found", { status: 404 });
  }
}

export async function saveContext(
  namespace: DurableObjectNamespace,
  context: GenerateContext
): Promise<void> {
  const id = namespace.idFromName(context.contextId);
  const stub = namespace.get(id);
  const response = await stub.fetch("https://context-store/put", {
    method: "POST",
    body: JSON.stringify({ context })
  });
  if (!response.ok) {
    throw new Error(`Context save failed with ${response.status}`);
  }
}

export async function loadContext(
  namespace: DurableObjectNamespace,
  contextId: string
): Promise<GenerateContext | null> {
  const id = namespace.idFromName(contextId);
  const stub = namespace.get(id);
  const response = await stub.fetch("https://context-store/get");
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Context load failed with ${response.status}`);
  }
  return (await response.json()) as GenerateContext;
}
