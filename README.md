# article-generator

一个部署在 Cloudflare Worker 的网页应用：输入 YouTube 链接，系统获取视频字幕并调用 Gemini，将内容整理为结构清晰的中文问答摘要稿。主文章采用 SSE 流式输出，生成过程中可以实时阅读；每个问答主题还支持独立生成 5W1H 总结。

公开访问地址：[https://article-generator.miles-victor.workers.dev](https://article-generator.miles-victor.workers.dev)

GitHub 仓库：[https://github.com/VictorGithub200/article-generator](https://github.com/VictorGithub200/article-generator)

## 功能概览

- 输入 YouTube 链接，自动抓取视频字幕。
- 可选上传本地 `.vtt`、`.srt`、`.txt` 字幕文件。上传后直接使用文件内容，不再请求 YouTube。
- 长字幕自动清理、分块，降低 Gemini 免费层配额限制对生成的影响。
- 使用 Gemini 流式生成 HTML，前端边接收边渲染。
- 支持自然语言生成要求，用于约束任务类型、输出风格、目标受众和内容边界。
- 输出内容按“大类标题 -> 问答主题 -> 主持人提问 + 嘉宾摘要回答”组织。
- 每个问答主题提供 `[5W1H]` 按钮，按需生成 Who / What / When / Where / Why / How 总结。

## 使用方式

页面包含三个输入项：

- `YouTube 链接`：必填，用于识别视频和尝试实时获取字幕。
- `本地字幕文件`：可选，支持 `.vtt`、`.srt`、`.txt`，最大 `2 MB`。选择文件后跳过 YouTube 实时抓取。
- `生成要求`：可选，支持自然语言描述。

示例生成要求：

```text
任务类型：访谈精华整理
输出风格：简洁、理性，保留关键论据
目标受众：关注 AI 创业机会的产品经理
约束条件：减少背景铺垫，重点呈现商业模式与成本趋势
```

## 如何获取和处理 YouTube 字幕

### 获取顺序

字幕入口位于 `src/lib/subtitles.ts`，处理顺序如下：

1. 如果用户上传本地字幕文件，直接使用文件内容，跳过 YouTube 网络请求。
2. 如果没有上传文件，解析 YouTube URL 中的 `videoId`。
3. 尝试从 YouTube watch page、播放器响应和 caption track 获取字幕。
4. 如果实时抓取失败，提示用户上传本地字幕文件。

本地文件优先是一个明确的工程取舍：当用户已经提供可靠字幕时，不再浪费时间请求 YouTube，也不触发代理或验证码链路。

### 字幕清理与分块

`src/lib/transcript-chunks.ts` 会在调用 Gemini 前统一清理字幕：

- 移除 `WEBVTT`、语言信息、字幕序号和时间戳。
- 移除 VTT 内联时间标签和 HTML 标签。
- 合并空白字符。
- 删除连续重复 cue。
- 优先沿字幕 cue 边界分块；超长单行再按标点切分。

默认每块约 `12,000` 字符，可通过 `TRANSCRIPT_CHUNK_CHARS` 调整，允许范围为 `4,000 - 30,000`。

### Webshare 代理

YouTube 可能对 Cloudflare Worker 或数据中心 IP 返回验证码、`429` 或 bot-check。Worker 原生 `fetch` 不支持代理参数，因此 `src/lib/proxy-http.ts` 使用 `cloudflare:sockets` 建立 TCP Socket，将完整 HTTPS URL 以 HTTP absolute-form 发送给 Webshare，由代理处理目标站点 TLS。

配置方式：

```bash
npx wrangler secret put WEBSHARE_PROXY_HOST
npx wrangler secret put WEBSHARE_PROXY_PORT
npx wrangler secret put WEBSHARE_PROXY_USERNAME
npx wrangler secret put WEBSHARE_PROXY_PASSWORD
npx wrangler secret put WEBSHARE_PROXY_ENDPOINTS
npx wrangler secret put WEBSHARE_PROXY_ONLY
```

`WEBSHARE_PROXY_ENDPOINTS` 支持多个 Direct Connection 节点，使用逗号分隔：

```text
38.154.203.95:5863,198.105.121.200:6462
```

配置多个节点后，系统会自动轮询。免费代理仍可能全部被 YouTube 标记为 bot 流量，此时应替换代理节点，或直接上传本地字幕文件。

## 如何调用 Gemini 并实现流式输出

主文章生成使用 Gemini `streamGenerateContent`：

```text
POST /v1beta/models/{model}:streamGenerateContent?alt=sse
```

默认模型为 `gemini-2.5-flash`，可以通过 `GEMINI_MODEL` 修改。

完整流式链路如下：

```text
字幕文本
  -> 清理与分块
  -> Worker 逐块调用 Gemini streamGenerateContent
  -> 解析 Gemini SSE
  -> Worker 通过 /api/generate 再次转发 SSE
  -> 浏览器增量拼接 HTML 并实时渲染
```

Worker 向前端发送五类事件：

- `meta`：字幕来源、清理后字符数、总批次数和 `contextId`。
- `progress`：当前处理批次、限流等待和自动重试状态。
- `chunk`：Gemini 当前返回的 HTML 增量。
- `done`：生成完成后的章节元信息。
- `error`：可展示给用户的错误信息。

为了兼容不同网络路径，服务端和前端 SSE 解析器都支持 `\n\n` 与 `\r\n\r\n` 分隔，并处理流结束时残留 buffer。

### 长字幕与免费配额

长字幕不会一次性发送给 Gemini，而是拆成多个请求顺序处理：

- 分块之间默认等待 `6.5` 秒，降低短时间触发 RPM 的概率。
- 遇到 Gemini `429` 时自动退避并重试，最多尝试 `3` 次。
- 每一块都会携带上一篇末尾约 `1,500` 字符作为连续性参考，减少说话人命名和主题衔接跳变。
- 每块产生的 HTML 都会立刻转发给浏览器，因此长字幕仍然具有实时反馈。

分块间隔可通过 `GEMINI_CHUNK_INTERVAL_MS` 调整。

## 如何根据用户生成要求影响输出结果

页面支持可选的自然语言生成要求。前端将其作为 `guidance` 字段提交，`src/prompts/article.ts` 会把内容注入每个字幕分块的提示词。

生成要求用于影响：

- 任务类型：例如访谈精华、行业观察、产品复盘。
- 输出风格：例如专业、简洁、面向大众、强调论据。
- 目标受众：例如开发者、产品经理、投资人。
- 约束条件：例如减少铺垫、关注商业模式、避免夸张结论。

系统仍会坚持基础边界：

- 只基于字幕内容，不编造字幕中不存在的事实。
- 不逐句转写，而是总结核心问题和关键回答。
- 每个具体主题原则上使用一轮“主持人提问 + 嘉宾摘要回答”。
- 将相关问答归入较少的大类，避免标题过度碎片化。

## 如何实现章节级 5W1H 总结

文章生成完成后，服务端会执行以下步骤：

1. 从生成 HTML 中抽取每个 `<section>` 问答主题。
2. 生成稳定的 `sectionId`、主题标题和摘要 excerpt。
3. 将完整字幕、完整文章 HTML 和章节元信息保存到 Durable Object。
4. 前端仅保留 `contextId` 和章节元信息。

用户点击某个主题旁的 `[5W1H]` 按钮时，前端只提交：

```json
{
  "contextId": "ctx_xxx",
  "sectionId": "sec_xxx"
}
```

服务端通过 `contextId` 从 Durable Object 读取本次生成上下文，再结合整篇文章和目标章节调用 Gemini `generateContent`。5W1H 请求要求 `application/json` 响应，最终固定渲染：

```text
Who
What
When
Where
Why
How
```

前端不会重新提交整篇文章，满足章节总结基于服务端上下文完成的约束。

## 主要工程取舍和亮点

- **本地字幕优先**：用户上传文件时跳过 YouTube，避免不必要的网络请求和验证码风险。
- **代理能力独立封装**：Webshare TCP Socket 逻辑集中在 `src/lib/proxy-http.ts`，不污染字幕解析和业务编排。
- **长字幕分块生成**：清理 VTT 噪声后再分块，显著减少输入 token；结合间隔控制与 `429` 自动退避，提高免费 API 可用性。
- **真正的全链路流式输出**：Gemini SSE 不会先聚合后展示，而是经 Worker 立即转发，浏览器实时增量渲染。
- **跨批次连续性**：每一块携带上一篇末尾短上下文，兼顾一致性与 token 成本。
- **层级化内容结构**：文章使用总标题、大类标题和具体问答主题三级结构，减少碎片化。
- **服务端保存生成上下文**：Durable Object 持久化字幕与文章，前端无需回传全文即可请求 5W1H。
- **模块边界清晰**：字幕获取、代理传输、字幕清理、Gemini 调用、提示词、章节解析和上下文存储均独立拆分。

## 架构与模块

```text
public/*
  -> src/index.ts
     -> src/lib/subtitles.ts
        -> src/lib/proxy-http.ts
     -> src/lib/transcript-chunks.ts
     -> src/prompts/article.ts
     -> src/lib/gemini.ts
     -> src/lib/sections.ts
     -> src/context-store-do.ts
```

主要模块：

- `src/index.ts`：Worker 路由、流式事件和生成流程编排。
- `src/lib/subtitles.ts`：本地字幕优先策略与 YouTube 字幕抓取。
- `src/lib/proxy-http.ts`：Cloudflare TCP Socket + Webshare 代理。
- `src/lib/transcript-chunks.ts`：字幕清理与按边界分块。
- `src/lib/gemini.ts`：Gemini 流式生成、JSON 生成和 `429` 自动退避。
- `src/prompts/article.ts`：问答摘要文章提示词。
- `src/prompts/fivew1h.ts`：章节级 5W1H 提示词和结果归一化。
- `src/lib/sections.ts`：具体问答主题抽取。
- `src/context-store-do.ts`：Durable Object 上下文持久化。
- `public/*`：前端表单、SSE 消费和实时 HTML 渲染。

## 本地开发

```bash
npm install
npx wrangler secret put GEMINI_API_KEY
npm run dev
```

## 部署

```bash
npm run deploy
```

部署后将获得公开访问 URL（`*.workers.dev`）。
