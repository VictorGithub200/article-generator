# article-generator

一个部署在 Cloudflare Worker 的网页应用：输入 YouTube 链接（可附带本地字幕文件），基于 Gemini API 流式生成中文问答摘要稿文章，并支持章节级 5W1H 总结。

## 功能概览

- YouTube 字幕策略：
  - 没有上传字幕文件时，实时抓取 YouTube 字幕。
  - 上传本地 `.vtt`、`.srt`、`.txt` 文件时，直接使用文件内容并跳过 YouTube 抓取。
  - 实时抓取失败时，提示用户上传本地字幕文件。
- 主文章生成：
  - 调用 Gemini `streamGenerateContent`。
  - 后端 SSE 流式转发，前端实时增量渲染 HTML。
  - 清理字幕时间戳和连续重复 cue，再按字幕 cue 边界分块调用 Gemini，降低长字幕触发免费层配额限制的概率。
  - 分块之间默认间隔 6.5 秒；遇到 Gemini `429` 时自动退避重试。
  - 每章以主持人核心问题开头，再展示嘉宾的摘要回答，不逐句复述全部字幕。
- 可选生成要求：
  - 支持输入自然语言约束（任务类型、风格、受众、约束条件）。
  - 通过 prompt 注入影响生成内容边界。
- 章节 5W1H：
  - 每章标题旁有 `[5W1H]` 按钮。
  - 前端仅发送 `contextId + sectionId`，不回传整篇文章。
  - 服务端从 Durable Object 读取本次生成上下文后再调用 Gemini 生成结构化结果。

## 架构与工程拆分

- `src/index.ts`：Worker 路由与 API 编排。
- `src/lib/subtitles.ts`：本地字幕优先与 YouTube 字幕抓取。
- `src/lib/transcript-chunks.ts`：字幕清理与按边界分块。
- `src/lib/proxy-http.ts`：可选 Webshare 代理（Cloudflare TCP Socket 实现）。
- `src/lib/gemini.ts`：Gemini 流式与普通 JSON 生成封装。
- `src/context-store-do.ts`：Durable Object 上下文持久化。
- `src/lib/sections.ts`：章节抽取与 section 元信息生成。
- `src/prompts/*`：文章与 5W1H 提示词模块。
- `public/*`：前端页面和交互。

## 本地开发

```bash
npm install
npx wrangler secret put GEMINI_API_KEY
npm run dev
```

打开本地地址后输入：
- YouTube 链接（必填）
- 本地字幕文件（可选，选择后跳过 YouTube 抓取）
- 生成要求（可选）

## 部署

```bash
npm run deploy
```

部署后将得到公开访问 URL（`*.workers.dev`）。

## 可选：Webshare 代理（遇到 YouTube 验证码时）

默认关闭代理。若出现验证码或抓取受限，可开启：

```bash
npx wrangler secret put WEBSHARE_PROXY_HOST
npx wrangler secret put WEBSHARE_PROXY_PORT
npx wrangler secret put WEBSHARE_PROXY_USERNAME
npx wrangler secret put WEBSHARE_PROXY_PASSWORD
npx wrangler secret put WEBSHARE_PROXY_ENDPOINTS
npx wrangler secret put WEBSHARE_PROXY_ONLY
```

`WEBSHARE_PROXY_ENDPOINTS` 可填写多个 Webshare Direct Connection 节点，以逗号分隔：

```text
38.154.203.95:5863,198.105.121.200:6462
```

说明：Worker 原生 `fetch` 不支持代理参数，因此通过 `cloudflare:sockets` 建立 TCP
连接，将完整 HTTPS URL 以 HTTP absolute-form 发送给 Webshare，由代理处理目标站点
TLS。配置多个节点后，系统会在 YouTube 返回 bot-check 时自动尝试下一个节点。

Webshare 免费节点仍可能被 YouTube 标记为 bot 流量。所有节点都失败时，页面会提示用户
替换代理节点或上传本地字幕文件。

## 主要工程取舍

- 用 Durable Object 存储“本次生成上下文”，满足 5W1H 不能由前端回传整文的约束。
- 主生成使用 SSE 全链路流式，提高可感知速度。
- 长字幕拆分为多个 Gemini 请求，兼顾免费层 TPM/RPM 限制与实时输出体验。
- 将 YouTube 抓取、Gemini 调用、章节解析、上下文存储拆分为独立模块，降低耦合。
- 代理能力做成可选开关：默认轻量可用，受限场景再启用。

## 参考示例文件

- `demo-dialog.txt`：你提供的演示文本（仅作为仓库参考，不作为字幕来源）。
