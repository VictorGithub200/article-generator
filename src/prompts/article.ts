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
    `这是完整视频字幕的第 ${params.chunkIndex + 1}/${params.chunkCount} 批。请将本批字幕提炼为中文问答摘要稿章节。`,
    "目标不是逐句转写，也不是第三人称分析文章。请按主题压缩字幕，将核心信息整理为主持人与嘉宾之间简洁、连贯的问答。",
    guidance,
    "硬性输出要求：",
    "1) 只输出 HTML 片段，不要 Markdown，不要代码块，不要输出 <article> 标签。",
    isFirst
      ? "2) 本批是第一批：先输出一个 <h1> 视频总标题，再输出大类标题和问答章节。"
      : "2) 本批不是第一批：直接输出大类标题和问答章节，不要再次输出 <h1>。",
    "3) 先将内容接近的问答归入较少的大类。每个大类使用 <h2 class=\"topic-group\">大类标题</h2>。大类标题要概括一组相关主题，不要为每个问答都创建一个大类。",
    "4) 每个大类下面包含若干问答章节。每个章节聚焦一个核心问题，并且必须以主持人的提问开头，再展示嘉宾的总结回答：",
    "   <h2 class=\"topic-group\">大类标题</h2>",
    `   <section id="sec-${params.chunkIndex + 1}-序号">`,
    "     <h3>简洁且有信息量的问答主题标题</h3>",
    "     <div class=\"dialogue-turn\">",
    "       <strong class=\"dialogue-speaker\">主持人:</strong>",
    "       <div class=\"dialogue-text\"><p>针对本章主题的核心问题</p></div>",
    "     </div>",
    "     <div class=\"dialogue-turn\">",
    "       <strong class=\"dialogue-speaker\">嘉宾:</strong>",
    "       <div class=\"dialogue-text\"><p>对相关字幕内容压缩后的核心回答</p></div>",
    "     </div>",
    "   </section>",
    "5) 控制层级数量：每个大类通常包含 2 至 4 个相关问答章节。只有讨论方向明显变化时，才新增大类。避免生成过多零散标题。",
    "6) 如果本批开头与上一批末尾仍属于同一大类，可以继续输出问答章节，不要重复输出相同的大类标题；只有进入新大类时才输出新的 <h2 class=\"topic-group\">。",
    "7) 每个章节原则上只输出一轮“主持人提问 + 嘉宾回答”。如果必须保留追问，才可增加少量问答轮次。禁止出现只有嘉宾发言、没有主持人问题的章节。",
    "8) 主持人的问题允许根据该段字幕核心主题进行提炼，不必逐字来自字幕；但不得引入字幕范围之外的新议题。",
    "9) 嘉宾回答必须是摘要式表达：删除寒暄、重复、铺垫和次要细节，只保留核心观点、关键论据和必要事实。不要完整复述所有字幕。",
    "10) 单个章节的嘉宾回答通常控制为 1 至 3 个自然段。内容较多时优先概括，不要无限扩写。",
    "11) 若字幕明确给出说话人姓名，可将“主持人”“嘉宾”替换为姓名；若无法确认，稳定使用“主持人”“嘉宾”“嘉宾 2”等中性称呼，不要猜测姓名。",
    "12) 保持主题出现的先后顺序，不要编造字幕中完全不存在的具体事实（数字、公司动作、时间点）。",
    "13) 当前批次可能从一段发言中间开始或结束。只提炼实际提供的内容，不要补写缺失上下文。",
    "",
    `视频链接：${params.youtubeUrl}`,
    continuity,
    "",
    "以下是当前批次字幕原文：",
    params.transcript
  ].join("\n");
}
