const form = document.getElementById("generateForm");
const submitBtn = document.getElementById("submitBtn");
const statusEl = document.getElementById("status");
const metaEl = document.getElementById("meta");
const articleOutput = document.getElementById("articleOutput");

let currentContextId = "";
let currentSections = [];
let articleHtmlBuffer = "";

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

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    buffer += value;

    const events = buffer.split("\n\n");
    buffer = events.pop() || "";

    for (const rawEvent of events) {
      const lines = rawEvent.split("\n");
      const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
      const dataLine = lines.find((line) => line.startsWith("data:"));
      if (!event || !dataLine) continue;

      let payloadObj = {};
      try {
        payloadObj = JSON.parse(dataLine.slice(5).trim());
      } catch {
        continue;
      }

      if (event === "meta") {
        currentContextId = payloadObj.contextId || "";
        const subtitleSourceLabel = payloadObj.subtitleSource === "youtube" ? "YouTube 实时字幕" : "用户输入字幕";
        metaEl.textContent = `contextId: ${currentContextId} | 字幕来源: ${subtitleSourceLabel}`;
        setStatus(payloadObj.subtitleDetail || "开始生成中...", "success");
      }

      if (event === "chunk") {
        articleHtmlBuffer += payloadObj.text || "";
        articleOutput.innerHTML = articleHtmlBuffer;
      }

      if (event === "done") {
        currentSections = Array.isArray(payloadObj.sections) ? payloadObj.sections : [];
        attachSectionActions();
        setStatus("文章生成完成，可点击各章节 5W1H。", "success");
      }

      if (event === "error") {
        throw new Error(payloadObj.message || "流式生成失败");
      }
    }
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  submitBtn.disabled = true;
  setStatus("正在准备字幕与模型请求...");
  metaEl.textContent = "";
  currentContextId = "";
  currentSections = [];
  articleHtmlBuffer = "";
  articleOutput.innerHTML = "";

  const payload = {
    youtubeUrl: document.getElementById("youtubeUrl").value.trim(),
    subtitleInput: document.getElementById("subtitleInput").value.trim(),
    guidance: document.getElementById("guidance").value.trim()
  };

  try {
    await streamGenerate(payload);
  } catch (error) {
    setStatus(error.message || "生成失败", "error");
  } finally {
    submitBtn.disabled = false;
  }
});
