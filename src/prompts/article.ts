export function buildArticlePrompt(params: {
  transcript: string;
  youtubeUrl: string;
  guidance?: string;
}): string {
  const guidance = params.guidance?.trim()
    ? `\n用户补充要求（可选，务必尽量遵守，但不要超出其约束范围）：\n${params.guidance.trim()}\n`
    : "\n用户未提供额外生成要求，可自行做合理结构化表达。\n";

  return [
    "你是资深中文科技内容编辑。",
    "请仅基于给定视频字幕内容，写一篇“视频对话内容文章”，目标是高可读性与信息密度。",
    guidance,
    "硬性输出要求：",
    "1) 只输出 HTML 片段，不要 Markdown，不要代码块。",
    "2) HTML 必须包含：<article> 根节点；文章标题；导语；多个章节。",
    "3) 每个章节必须使用以下结构：",
    "   <section id=\"sec-序号\">",
    "     <h2>章节标题</h2>",
    "     <p>章节正文（可多段）</p>",
    "   </section>",
    "4) 章节标题应简洁有信息量，正文用中文，强调观点、论据、对话脉络。",
    "5) 若字幕存在口语、噪声或重复，需去噪并保持原意。",
    "6) 文末补一段“结语”，总结视频核心洞察与可行动建议。",
    "7) 不要编造字幕中完全不存在的具体事实（数字、公司动作、时间点）。",
    "",
    `视频链接：${params.youtubeUrl}`,
    "",
    "以下是字幕原文：",
    params.transcript
  ].join("\n");
}
