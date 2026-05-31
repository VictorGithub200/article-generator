import type { SectionContext } from "../types";
import { buildExcerpt } from "./utils";

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function extractSections(articleHtml: string): SectionContext[] {
  const sectionRegex = /<section[^>]*>([\s\S]*?)<\/section>/gi;
  const results: SectionContext[] = [];
  let match: RegExpExecArray | null;
  let idx = 1;

  while ((match = sectionRegex.exec(articleHtml))) {
    const sectionHtml = match[1] || "";
    const titleMatch =
      sectionHtml.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i) ||
      sectionHtml.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const title = titleMatch
      ? titleMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
      : `章节 ${idx}`;

    results.push({
      id: `sec-${idx}-${slugify(title) || idx}`,
      title,
      excerpt: buildExcerpt(sectionHtml)
    });
    idx += 1;
  }

  return results;
}
