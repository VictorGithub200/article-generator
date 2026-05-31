const DEFAULT_CHUNK_CHARS = 12_000;
const MIN_CHUNK_CHARS = 4_000;
const MAX_CHUNK_CHARS = 30_000;

function chunkSizeFromEnv(raw: string | undefined): number {
  const parsed = Number.parseInt(raw || "", 10);
  if (!Number.isFinite(parsed)) return DEFAULT_CHUNK_CHARS;
  return Math.min(Math.max(parsed, MIN_CHUNK_CHARS), MAX_CHUNK_CHARS);
}

function isTimestampLine(line: string): boolean {
  return /^\s*(?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{3}\s+-->\s+(?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{3}/.test(line);
}

function normalizeCueLine(line: string): string {
  return line
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function splitOversizedLine(line: string, maxChars: number): string[] {
  const results: string[] = [];
  let rest = line;

  while (rest.length > maxChars) {
    const candidate = rest.slice(0, maxChars);
    const punctuation = Math.max(
      candidate.lastIndexOf("。"),
      candidate.lastIndexOf("！"),
      candidate.lastIndexOf("？"),
      candidate.lastIndexOf(". "),
      candidate.lastIndexOf("? "),
      candidate.lastIndexOf("! ")
    );
    const splitAt = punctuation > maxChars * 0.55 ? punctuation + 1 : maxChars;
    results.push(rest.slice(0, splitAt).trim());
    rest = rest.slice(splitAt).trim();
  }

  if (rest) results.push(rest);
  return results;
}

export function cleanTranscript(raw: string): string {
  const normalized = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const output: string[] = [];
  let previous = "";

  for (const rawLine of normalized.split("\n")) {
    const line = rawLine.trim();
    if (
      !line ||
      line === "WEBVTT" ||
      /^NOTE(?:\s|$)/.test(line) ||
      /^Kind:\s*/i.test(line) ||
      /^Language:\s*/i.test(line) ||
      /^\d+$/.test(line) ||
      isTimestampLine(line)
    ) {
      continue;
    }

    const clean = normalizeCueLine(line);
    if (!clean || clean === previous) continue;
    output.push(clean);
    previous = clean;
  }

  return output.join("\n");
}

export function splitTranscript(raw: string, configuredChunkChars?: string): string[] {
  const transcript = cleanTranscript(raw);
  if (!transcript) return [];

  const maxChars = chunkSizeFromEnv(configuredChunkChars);
  const lines = transcript
    .split("\n")
    .flatMap((line) => splitOversizedLine(line, maxChars));
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLength = 0;

  for (const line of lines) {
    const nextLength = currentLength + (current.length ? 1 : 0) + line.length;
    if (current.length && nextLength > maxChars) {
      chunks.push(current.join("\n"));
      current = [];
      currentLength = 0;
    }

    current.push(line);
    currentLength += (current.length > 1 ? 1 : 0) + line.length;
  }

  if (current.length) chunks.push(current.join("\n"));
  return chunks;
}

