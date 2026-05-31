const form = document.getElementById("generateForm");
const submitBtn = document.getElementById("submitBtn");
const statusEl = document.getElementById("status");
const metaEl = document.getElementById("meta");
const articleOutput = document.getElementById("articleOutput");
const subtitleFileInput = document.getElementById("subtitleFile");
const subtitleFileMeta = document.getElementById("subtitleFileMeta");

let currentContextId = "";
let currentSections = [];
let articleHtmlBuffer = "";
const maxSubtitleFileBytes = 2 * 1024 * 1024;

function setStatus(message, type = "") {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`.trim();
}

function renderFiveW1H(container, summary) {
  const keys = ["Who", "What", "When", "Where", "Why", "How"];
  container.innerHTML = keys
    .map(
      (key) =>
        `<div class="fivew1h-row"><strong>${key}</strong><span>${summary[key] || "未在上下文明确给出"}</span></div>`
    )
    .join("");
}

async function requestFiveW1H(sectionId, resultContainer, triggerBtn) {
  if (!currentContextId) return;
  triggerBtn.disabled = true;
  triggerBtn.textContent = "生成中...";

  try {
    const response = await fetch("/api/5w1h", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contextId: currentContextId,
        sectionId
      })
    });

    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "5W1H 请求失败");

    renderFiveW1H(resultContainer, payload.summary || {});
    resultContainer.hidden = false;
    triggerBtn.textContent = "刷新 5W1H";
  } catch (error) {
    resultContainer.innerHTML = `<span style="color:#b72c1f;">${error.message}</span>`;
    resultContainer.hidden = false;
    triggerBtn.textContent = "重试 5W1H";
  } finally {
    triggerBtn.disabled = false;
  }
}

function attachSectionActions() {
  const sections = articleOutput.querySelectorAll("section");
  sections.forEach((section, index) => {
    const h2 = section.querySelector("h2");
    if (!h2) return;

    const sectionMeta = currentSections[index];
    if (!sectionMeta) return;

    section.dataset.sectionId = sectionMeta.id;

    const tools = document.createElement("span");
    tools.className = "sec-tools";
    tools.innerHTML = `<button type="button" class="btn-mini">5W1H</button>`;

    const detail = document.createElement("div");
    detail.className = "fivew1h";
    detail.hidden = true;

    const button = tools.querySelector("button");
    button.addEventListener("click", () => requestFiveW1H(sectionMeta.id, detail, button));

    h2.appendChild(tools);
    section.appendChild(detail);
  });
}

function drainSseBlocks(buffer, flush = false) {
  const blocks = [];
  const separator = /\r?\n\r?\n/g;
  let start = 0;
  let match;

  while ((match = separator.exec(buffer))) {
    blocks.push(buffer.slice(start, match.index));
    start = separator.lastIndex;
  }

  const rest = buffer.slice(start);
  if (flush && rest.trim()) {
    blocks.push(rest);
    return { blocks, rest: "" };
  }

  return { blocks, rest };
}

async function readSubtitleFile() {
  const file = subtitleFileInput.files?.[0];
  if (!file) return { text: "", filename: "" };
  if (file.size > maxSubtitleFileBytes) {
    throw new Error("字幕文件不能超过 2 MB");
  }

  return {
    text: await file.text(),
    filename: file.name
  };
}

async function streamGenerate(payload) {
  const response = await fetch("/api/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `请求失败: ${response.status}`);
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";

  const processBlocks = (blocks) => {
    for (const rawEvent of blocks) {
      const lines = rawEvent.split(/\r?\n/);
      const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
      const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
        .trim();
      if (!event || !data) continue;

      let payloadObj = {};
      try {
        payloadObj = JSON.parse(data);
      } catch {
        continue;
      }

      if (event === "meta") {
        currentContextId = payloadObj.contextId || "";
        const subtitleSourceLabel =
          payloadObj.subtitleSource === "youtube"
            ? "YouTube 实时字幕"
            : payloadObj.subtitleSource === "user_file"
              ? "本地字幕文件"
              : "用户输入字幕";
        metaEl.textContent =
          `contextId: ${currentContextId} | 字幕来源: ${subtitleSourceLabel}` +
          ` | 字幕字符: ${payloadObj.transcriptChars || 0}` +
          ` | 生成批次: ${payloadObj.chunkCount || 1}`;
        setStatus(payloadObj.subtitleDetail || "开始生成中...", "success");
      }

      if (event === "progress") {
        setStatus(payloadObj.message || "正在分批生成...");
      }

      if (event === "chunk") {
        articleHtmlBuffer += payloadObj.text || "";
        articleOutput.innerHTML = articleHtmlBuffer;
      }

      if (event === "done") {
        if (!articleHtmlBuffer.trim()) {
          throw new Error("文章生成完成，但未收到正文内容，请重试");
        }

        currentSections = Array.isArray(payloadObj.sections) ? payloadObj.sections : [];
        attachSectionActions();
        setStatus("文章生成完成，可点击各章节 5W1H。", "success");
      }

      if (event === "error") {
        throw new Error(payloadObj.message || "流式生成失败");
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    buffer += value;

    const drained = drainSseBlocks(buffer);
    buffer = drained.rest;
    processBlocks(drained.blocks);
  }

  processBlocks(drainSseBlocks(buffer, true).blocks);
}

subtitleFileInput.addEventListener("change", () => {
  const file = subtitleFileInput.files?.[0];
  subtitleFileMeta.textContent = file
    ? `${file.name} | ${(file.size / 1024).toFixed(1)} KB | 将优先使用文件内容`
    : "支持 .vtt、.srt、.txt，选择文件后优先使用文件内容，最大 2 MB。";
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  submitBtn.disabled = true;
  setStatus("正在准备字幕与模型请求...");
  metaEl.textContent = "";
  currentContextId = "";
  currentSections = [];
  articleHtmlBuffer = "";
  articleOutput.innerHTML = "";

  try {
    const subtitleFile = await readSubtitleFile();
    const payload = {
      youtubeUrl: document.getElementById("youtubeUrl").value.trim(),
      subtitleInput: subtitleFile.text || document.getElementById("subtitleInput").value.trim(),
      subtitleFilename: subtitleFile.filename,
      guidance: document.getElementById("guidance").value.trim()
    };
    await streamGenerate(payload);
  } catch (error) {
    setStatus(error.message || "生成失败", "error");
  } finally {
    submitBtn.disabled = false;
  }
});
