# article-generator

一个部署在 Cloudflare Worker 的网页应用：输入 YouTube 链接（可附带字幕回退文本），基于 Gemini API 流式生成中文视频对话内容文章，并支持章节级 5W1H 总结。

## 功能概览

- YouTube 字幕策略：
  - 优先实时抓取 YouTube 字幕。
  - 抓取失败时，自动回退到用户输入字幕（不是 demo 文本）。
- 主文章生成：
  - 调用 Gemini `streamGenerateContent`。
  - 后端 SSE 流式转发，前端实时增量渲染 HTML。
- 可选生成要求：
  - 支持输入自然语言约束（任务类型、风格、受众、约束条件）。
  - 通过 prompt 注入影响生成内容边界。
- 章节 5W1H：
  - 每章标题旁有 `[5W1H]` 按钮。
  - 前端仅发送 `contextId + sectionId`，不回传整篇文章。
  - 服务端从 Durable Object 读取本次生成上下文后再调用 Gemini 生成结构化结果。

## 架构与工程拆分

- `src/index.ts`：Worker 路由与 API 编排。
- `src/lib/subtitles.ts`：YouTube 字幕抓取与回退。
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
- 字幕回退文本（可选，但建议填，防止 YouTube 抓取失败）
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
npx wrangler secret put WEBSHARE_PROXY_USERNAME
npx wrangler secret put WEBSHARE_PROXY_PASSWORD
```

并在 `wrangler.toml` 保持：

```toml
WEBSHARE_PROXY_ENABLED = "true"
WEBSHARE_PROXY_PORT = "80"
```

说明：Worker 原生 `fetch` 不支持代理参数，因此通过 `cloudflare:sockets` 走 TCP 直连代理端点完成请求。

## 主要工程取舍

- 用 Durable Object 存储“本次生成上下文”，满足 5W1H 不能由前端回传整文的约束。
- 主生成使用 SSE 全链路流式，提高可感知速度。
- 将 YouTube 抓取、Gemini 调用、章节解析、上下文存储拆分为独立模块，降低耦合。
- 代理能力做成可选开关：默认轻量可用，受限场景再启用。

## 参考示例文件

- `demo-dialog.txt`：你提供的演示文本（仅作为仓库参考，不作为默认回退字幕来源）。
