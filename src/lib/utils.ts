export const textEncoder = new TextEncoder();
export const textDecoder = new TextDecoder();

export function toSafeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function randomId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const token = Array.from(bytes)
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
  return `${prefix}_${token}`;
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });
}

export function extractVideoId(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.hostname.includes("youtu.be")) {
      return url.pathname.replace(/^\//, "") || null;
    }
    if (url.pathname === "/watch") {
      return url.searchParams.get("v");
    }
    const shorts = url.pathname.match(/^\/shorts\/([\w-]{6,})/);
    if (shorts) return shorts[1];
    const embed = url.pathname.match(/^\/embed\/([\w-]{6,})/);
    if (embed) return embed[1];
    return null;
  } catch {
    return null;
  }
}

export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildExcerpt(input: string, maxLength = 420): string {
  const clean = stripHtml(input);
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength)}...`;
}
