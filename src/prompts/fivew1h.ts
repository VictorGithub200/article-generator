import type { FiveW1HResult } from "../types";

export function buildFiveW1HPrompt(params: {
  fullArticle: string;
  sectionTitle: string;
  sectionExcerpt: string;
}): string {
  return [
    "你是内容分析助手。",
    "请基于“整篇文章上下文”与“目标章节”，生成该章节的 5W1H 总结。",
    "要求：",
    "1) 使用中文。",
    "2) 返回严格 JSON 对象，且仅包含这 6 个键：Who, What, When, Where, Why, How。",
    "3) 每个字段保持一句到两句，简洁准确，不要冗长。",
    "4) 若信息不足，明确写“未在上下文明确给出”。",
    "",
    "整篇文章：",
    params.fullArticle,
    "",
    "目标章节标题：",
    params.sectionTitle,
    "",
    "目标章节摘录：",
    params.sectionExcerpt
  ].join("\n");
}

export function normalizeFiveW1H(raw: any): FiveW1HResult {
  const get = (key: string) => {
    const value = raw?.[key];
    return typeof value === "string" && value.trim() ? value.trim() : "未在上下文明确给出";
  };

  return {
    Who: get("Who"),
    What: get("What"),
    When: get("When"),
    Where: get("Where"),
    Why: get("Why"),
    How: get("How")
  };
}
