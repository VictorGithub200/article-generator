interface ArticleChunkPromptParams {
  transcript: string;
  youtubeUrl: string;
  guidance?: string;
  chunkIndex: number;
  chunkCount: number;
  continuityContext?: string;
}

export function buildArticleChunkPrompt(params: ArticleChunkPromptParams): string {
  const guidance = params.guidance?.trim()
    ? `\n用户补充要求（可选，务必尽量遵守，但不要超出其约束范围）：\n${params.guidance.trim()}\n`
    : "\n用户未提供额外生成要求，可自行做合理结构化表达。\n";
  const isFirst = params.chunkIndex === 0;
  const continuity = params.continuityContext?.trim()
    ? [
        "",
        "上一批次生成内容的末尾如下。它只用于保持说话人称呼和上下文连续，不要重复输出其中内容：",
        params.continuityContext.trim()
      ].join("\n")
    : "";

  return [
    "你是资深中文科技内容编辑。",
    `这是完整视频字幕的第 ${params.chunkIndex + 1}/${params.chunkCount} 批。请将本批字幕整理为中文对话稿章节。`,
    "目标不是写分析型文章，而是保留问答与讨论的对话形式；只对口语内容做去噪、翻译、合并重复表达，并按主题分段。",
    guidance,
    "硬性输出要求：",
    "1) 只输出 HTML 片段，不要 Markdown，不要代码块，不要输出 <article> 标签。",
    isFirst
      ? "2) 本批是第一批：先输出一个 <h1> 视频总标题，再输出一个或多个 <section> 对话章节。"
      : "2) 本批不是第一批：直接输出一个或多个 <section> 对话章节，不要再次输出 <h1>。",
    "3) 按讨论主题切分章节。每个章节必须使用以下结构：",
    `   <section id="sec-${params.chunkIndex + 1}-序号">`,
    "     <h2>简洁且有信息量的章节标题</h2>",
    "     <div class=\"dialogue-turn\">",
    "       <strong class=\"dialogue-speaker\">说话人:</strong>",
    "       <div class=\"dialogue-text\"><p>该说话人的对话内容</p></div>",
    "     </div>",
    "   </section>",
    "4) 每次说话人切换都必须新建一个 <div class=\"dialogue-turn\">。较长发言可在同一个 <div class=\"dialogue-text\"> 内拆成多个 <p>。",
    "5) 保留本批字幕的原始问答顺序、核心观点、论据和对话脉络。不要把对话改写为第三人称叙事，不要新增字幕中不存在的问答。",
    "6) 若字幕明确给出说话人姓名，使用姓名；若无法确认，稳定使用“主持人”“嘉宾”“嘉宾 2”等中性称呼，不要猜测姓名。",
    "7) 若字幕存在口语、噪声或重复，需适度去噪并保持原意。可以提高中文可读性，但不要过度压缩信息。",
    "8) 不要编造字幕中完全不存在的具体事实（数字、公司动作、时间点）。",
    "9) 当前批次可能从一段发言中间开始或结束。只整理实际提供的内容，不要补写缺失上下文。",
    "",
    `视频链接：${params.youtubeUrl}`,
    continuity,
    "",
    "以下是当前批次字幕原文：",
    params.transcript
  ].join("\n");
}
