const modelsSourceSelect = document.querySelector("#models-source");
const agentSelect = document.querySelector("#agent");
const transportSelect = document.querySelector("#transport");
const modelSelect = document.querySelector("#model");
const reasoningEffortSelect = document.querySelector("#reasoning-effort");
const statusEl = document.querySelector("#status");
const elapsedEl = document.querySelector("#elapsed");
const chatEl = document.querySelector("#chat");
const form = document.querySelector("#form");
const messageInput = document.querySelector("#message");
const sendButton = document.querySelector("#send");
const newChatButton = document.querySelector("#new-chat");
const reloadButton = document.querySelector("#reload");
const inspectButton = document.querySelector("#inspect");
const inspectCodeEl = document.querySelector("#inspect-code");
const inspectOutputEl = document.querySelector("#inspect-output");

let modelsByAgent = {};
let elapsedTimerId = null;
const messages = [];
const fallbackReasoningEffortOptionsByAgent = {
  codex: ["default", "none", "minimal", "low", "medium", "high", "xhigh", "max"],
  claude: ["default", "low", "medium", "high", "xhigh", "max"],
  agy: ["default", "none", "minimal", "low", "medium", "high", "xhigh", "max"],
  grok: ["default", "low", "medium", "high", "xhigh"],
  devin: ["default", "none", "minimal", "low", "medium", "high", "xhigh", "max"]
};

const savedModelsSource = localStorage.getItem("modelsSource");
if (savedModelsSource === "local" || savedModelsSource === "shared") {
  modelsSourceSelect.value = savedModelsSource;
}

newChatButton.addEventListener("click", startNewChat);
reloadButton.addEventListener("click", loadModels);
inspectButton.addEventListener("click", runInspect);
modelsSourceSelect.addEventListener("change", () => {
  localStorage.setItem("modelsSource", modelsSourceSelect.value);
  loadModels();
});
agentSelect.addEventListener("change", () => {
  renderTransportOptions();
  renderModelOptions();
  renderReasoningEffortOptions();
});
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await sendMessage();
});

await loadModels();

async function loadModels() {
  setStatus("Loading models...");
  sendButton.disabled = true;

  try {
    const source = modelsSourceSelect.value;
    const response = await fetch(`/api/models?source=${encodeURIComponent(source)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Failed to load models");

    modelsByAgent = data.agents;
    renderAgentOptions();
    renderTransportOptions();
    renderModelOptions();
    renderReasoningEffortOptions();
    const configError = Object.values(modelsByAgent).find((entry) => entry?.error)?.error;
    setStatus(configError ?? `Models loaded from ${data.modelsPath}.`, Boolean(configError));
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    updateSendState();
  }
}

async function sendMessage() {
  const content = messageInput.value.trim();
  if (!content) return;

  const agent = agentSelect.value;
  const transport = transportSelect.value;
  const model = modelSelect.value;
  const reasoningEffort = reasoningEffortSelect.value;
  messages.push({ role: "user", content });
  renderMessages();
  messageInput.value = "";
  setStatus(
    `Running ${agent} (${transport}) with ${model}${reasoningEffort ? ` / ${reasoningEffort}` : ""}...`
  );
  sendButton.disabled = true;

  const startedAt = performance.now();
  startElapsedTimer(startedAt);

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent,
        transport,
        model,
        reasoningEffort,
        messages,
        source: modelsSourceSelect.value
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Chat failed");

    messages.push({
      role: "assistant",
      content: data.reply || "(empty response)",
      elapsedMs: performance.now() - startedAt
    });
    renderMessages();
    mergeRuntimeModels(agent, data.models);
    setStatus(data.sessionId ? `Ready. session: ${data.sessionId}` : "Ready.");
  } catch (error) {
    messages.push({
      role: "assistant",
      content: `Error: ${error.message}`,
      elapsedMs: performance.now() - startedAt
    });
    renderMessages();
    setStatus(error.message, true);
  } finally {
    stopElapsedTimer(performance.now() - startedAt);
    updateSendState();
  }
}

async function runInspect() {
  setStatus("Running inspect...");
  inspectButton.disabled = true;

  try {
    const response = await fetch("/api/inspect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: modelsSourceSelect.value })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Inspect failed");

    inspectCodeEl.textContent = `exit ${data.code}`;
    const stderrLabel = data.code === 0 ? "warnings:" : "stderr:";
    inspectOutputEl.textContent = [
      "$ headless-core models inspect",
      "",
      "stdout:",
      data.stdout || "(empty)",
      "",
      stderrLabel,
      data.stderr || "(empty)"
    ].join("\n");
    setStatus(
      data.stderr
        ? "Inspect completed with warnings. It does not update models.json."
        : "Inspect completed. It does not update models.json."
    );
    if (data.agents) {
      modelsByAgent = data.agents;
      renderAgentOptions();
      renderTransportOptions();
      renderModelOptions();
      renderReasoningEffortOptions();
    }
  } catch (error) {
    inspectCodeEl.textContent = "";
    inspectOutputEl.textContent = "";
    setStatus(error.message, true);
  } finally {
    inspectButton.disabled = false;
  }
}

function renderAgentOptions() {
  const previous = agentSelect.value;
  agentSelect.replaceChildren();
  for (const agent of Object.keys(modelsByAgent)) {
    const option = document.createElement("option");
    option.value = agent;
    option.textContent = agent;
    agentSelect.append(option);
  }
  if (previous && modelsByAgent[previous]) {
    agentSelect.value = previous;
  }
}

async function startNewChat() {
  messages.length = 0;
  renderMessages();

  const transport = transportSelect.value;
  if (transport === "cli") {
    setStatus("Ready.");
    return;
  }

  try {
    const response = await fetch("/api/session/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: agentSelect.value, transport })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Session reset failed");
    setStatus(data.reset ? `Session reset. session: ${data.sessionId}` : "Ready.");
  } catch (error) {
    setStatus(error.message, true);
  }
}

// Merges model ids reported by a live persistent session into the dropdown so
// runtime-only ids (codex model/list, devin acp config options) stay selectable.
function mergeRuntimeModels(agent, models) {
  const entry = modelsByAgent[agent];
  if (!entry || !Array.isArray(models) || models.length === 0) {
    return;
  }
  const merged = [...entry.models];
  for (const model of models) {
    if (!merged.includes(model)) {
      merged.push(model);
    }
  }
  entry.models = merged;
  renderModelOptions();
}

function renderTransportOptions() {
  const agent = agentSelect.value;
  const transports = modelsByAgent[agent]?.transports ?? ["cli"];
  const previous = transportSelect.value;
  transportSelect.replaceChildren();
  transportSelect.disabled = transports.length <= 1;
  for (const transport of transports) {
    const option = document.createElement("option");
    option.value = transport;
    option.textContent = transport;
    transportSelect.append(option);
  }
  transportSelect.value = transports.includes(previous) ? previous : "cli";
}

function renderModelOptions() {
  const agent = agentSelect.value;
  const models = modelsByAgent[agent]?.models ?? [];
  const previous = modelSelect.value;
  modelSelect.replaceChildren();
  for (const model of models) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = model;
    modelSelect.append(option);
  }
  if (previous && models.includes(previous)) {
    modelSelect.value = previous;
  }
  updateSendState();
}

function renderReasoningEffortOptions() {
  const agent = agentSelect.value;
  const reasoningEffortOptions = getReasoningEffortOptions(agent);
  reasoningEffortSelect.replaceChildren();

  reasoningEffortSelect.disabled = reasoningEffortOptions.length <= 1;
  for (const reasoningEffort of reasoningEffortOptions) {
    const option = document.createElement("option");
    option.value = reasoningEffort === "default" ? "" : reasoningEffort;
    option.textContent = reasoningEffort;
    reasoningEffortSelect.append(option);
  }
  reasoningEffortSelect.value = "";
}

function getReasoningEffortOptions(agent) {
  const options = modelsByAgent[agent]?.reasoningEffortOptions;
  if (Array.isArray(options) && options.length > 0) {
    return options;
  }
  return fallbackReasoningEffortOptionsByAgent[agent] ?? ["default"];
}

function renderMessages() {
  chatEl.replaceChildren();
  for (const message of messages) {
    const node = document.createElement("article");
    node.className = `message ${message.role}`;
    const body = document.createElement("div");
    body.textContent = message.content;
    node.append(body);
    if (message.elapsedMs != null) {
      const meta = document.createElement("div");
      meta.className = "message-meta";
      meta.textContent = formatDuration(message.elapsedMs);
      node.append(meta);
    }
    chatEl.append(node);
  }
  chatEl.scrollTop = chatEl.scrollHeight;
}

function startElapsedTimer(startedAt) {
  stopElapsedTimer();
  renderElapsed(performance.now() - startedAt);
  elapsedTimerId = setInterval(() => renderElapsed(performance.now() - startedAt), 100);
}

function stopElapsedTimer(finalMs) {
  if (elapsedTimerId !== null) {
    clearInterval(elapsedTimerId);
    elapsedTimerId = null;
  }
  if (finalMs !== undefined) {
    renderElapsed(finalMs);
  }
}

function renderElapsed(ms) {
  elapsedEl.textContent = formatDuration(ms);
}

function formatDuration(ms) {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(Math.floor(seconds % 60)).padStart(2, "0")}s`;
}

function updateSendState() {
  sendButton.disabled = !modelSelect.value;
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}
