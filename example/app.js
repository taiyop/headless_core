const agentSelect = document.querySelector("#agent");
const modelSelect = document.querySelector("#model");
const reasoningEffortSelect = document.querySelector("#reasoning-effort");
const statusEl = document.querySelector("#status");
const chatEl = document.querySelector("#chat");
const form = document.querySelector("#form");
const messageInput = document.querySelector("#message");
const sendButton = document.querySelector("#send");
const reloadButton = document.querySelector("#reload");
const inspectButton = document.querySelector("#inspect");
const inspectCodeEl = document.querySelector("#inspect-code");
const inspectOutputEl = document.querySelector("#inspect-output");

let modelsByAgent = {};
const messages = [];
const fallbackReasoningEffortOptionsByAgent = {
  codex: ["default", "low", "medium", "high", "xhigh"],
  claude: ["default", "low", "medium", "high", "xhigh", "max"],
  agy: ["default"],
  grok: ["default"]
};

reloadButton.addEventListener("click", loadModels);
inspectButton.addEventListener("click", runInspect);
agentSelect.addEventListener("change", () => {
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
    const response = await fetch("/api/models");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Failed to load models");

    modelsByAgent = data.agents;
    renderAgentOptions();
    renderModelOptions();
    renderReasoningEffortOptions();
    setStatus("Models loaded from shared config.");
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
  const model = modelSelect.value;
  const reasoningEffort = reasoningEffortSelect.value;
  messages.push({ role: "user", content });
  renderMessages();
  messageInput.value = "";
  setStatus(`Running ${agent} with ${model}${reasoningEffort ? ` / ${reasoningEffort}` : ""}...`);
  sendButton.disabled = true;

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent, model, reasoningEffort, messages })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Chat failed");

    messages.push({ role: "assistant", content: data.reply || "(empty response)" });
    renderMessages();
    setStatus("Ready.");
  } catch (error) {
    messages.push({ role: "assistant", content: `Error: ${error.message}` });
    renderMessages();
    setStatus(error.message, true);
  } finally {
    updateSendState();
  }
}

async function runInspect() {
  setStatus("Running inspect...");
  inspectButton.disabled = true;

  try {
    const response = await fetch("/api/inspect", { method: "POST" });
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

function renderModelOptions() {
  const agent = agentSelect.value;
  const models = modelsByAgent[agent]?.models ?? [];
  modelSelect.replaceChildren();
  for (const model of models) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = model;
    modelSelect.append(option);
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
    node.textContent = message.content;
    chatEl.append(node);
  }
  chatEl.scrollTop = chatEl.scrollHeight;
}

function updateSendState() {
  sendButton.disabled = !modelSelect.value;
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}
