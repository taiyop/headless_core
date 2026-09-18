import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createHeadlessCore,
  DEFAULT_REASONING_EFFORT_ID,
  DEFAULT_MODEL_ID,
  getAvailableReasoningEffortOptions,
  getAvailableModels,
  ModelAvailabilityError
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const preferredPort = Number(process.env.PORT ?? 4173);
const host = process.env.HOST ?? "127.0.0.1";
const maxPortAttempts = 20;
let port = preferredPort;

const envModelsPath = process.env.HEADLESS_CORE_MODELS_PATH;
const localModelsPath = envModelsPath ?? path.join(__dirname, "models.json");
// Same default as resolveModelsConfigPath in src/config.ts.
const sharedModelsPath = path.join(homedir(), ".config", "headless-core", "models.json");

const agents = ["codex", "claude", "agy", "grok", "devin"];
const exampleBinDir = path.join(__dirname, "bin");
let inspectedModelsByAgent = null;
const headless = createHeadlessCore({
  timeoutMs: 120_000
});

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${port}`}`);

    if (req.method === "GET" && url.pathname === "/") {
      return serveFile(res, path.join(__dirname, "index.html"), "text/html; charset=utf-8");
    }

    if (req.method === "GET" && url.pathname === "/styles.css") {
      return serveFile(res, path.join(__dirname, "styles.css"), "text/css; charset=utf-8");
    }

    if (req.method === "GET" && url.pathname === "/app.js") {
      return serveFile(res, path.join(__dirname, "app.js"), "text/javascript; charset=utf-8");
    }

    if (req.method === "GET" && url.pathname === "/api/models") {
      const source = normalizeModelsSource(url.searchParams.get("source"));
      const modelsPath = applyModelsSource(source);
      return json(res, 200, { source, modelsPath, agents: await loadModelsByAgent() });
    }

    if (req.method === "POST" && url.pathname === "/api/inspect") {
      const body = await readJson(req);
      const result = await runInspect(normalizeModelsSource(body.source));
      return json(res, 200, result);
    }

    if (req.method === "POST" && url.pathname === "/api/chat") {
      const body = await readJson(req);
      const reply = await runChat(body);
      return json(res, 200, { reply });
    }

    return json(res, 404, { error: "Not found" });
  } catch (error) {
    return json(res, 500, serializeError(error));
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE" && port < preferredPort + maxPortAttempts) {
    const nextPort = port + 1;
    console.log(`Port ${port} is in use, trying ${nextPort}...`);
    port = nextPort;
    server.listen(port, host);
    return;
  }
  throw error;
});

server.on("listening", () => {
  console.log(`Example chat running at http://${host}:${port}`);
  console.log(`Models config sources: local=${localModelsPath} shared=${sharedModelsPath}`);
});

server.listen(port, host);

async function loadModelsByAgent() {
  const result = {};
  for (const agent of agents) {
    const reasoningEffortOptions = getAvailableReasoningEffortOptions({ agent });
    try {
      result[agent] = { models: await getAvailableModels({ agent }), reasoningEffortOptions };
    } catch (error) {
      const inspectedModels = inspectedModelsByAgent?.[agent];
      result[agent] = {
        models: inspectedModels ?? [],
        reasoningEffortOptions,
        ...(inspectedModels ? { source: "inspect" } : { error: serializeError(error).error })
      };
    }
  }
  return result;
}

async function runChat(body) {
  const agent = asString(body.agent);
  const model = asString(body.model);
  const rawReasoningEffort = asString(body.reasoningEffort);
  const reasoningEffort = rawReasoningEffort === DEFAULT_REASONING_EFFORT_ID ? "" : rawReasoningEffort;
  const messages = Array.isArray(body.messages) ? body.messages : [];

  if (!agents.includes(agent)) {
    throw new Error(`Unsupported agent: ${agent}`);
  }
  if (!model) {
    throw new Error("Model is required");
  }
  const reasoningEffortOptions = getAvailableReasoningEffortOptions({ agent });
  if (reasoningEffort && !reasoningEffortOptions.includes(reasoningEffort)) {
    throw new Error(`Unsupported reasoning effort: ${reasoningEffort}`);
  }

  applyModelsSource(asString(body.source));
  const availableModels = await getAvailableModelsForChat(agent);
  if (!availableModels.includes(model)) {
    throw new Error(`Model "${model}" is not available for ${agent}`);
  }

  const prompt = buildPrompt(messages);
  return headless.run({
    agent: {
      provider: agent,
      model,
      ...(reasoningEffort ? { reasoningEffort } : {})
    },
    prompt
  });
}

async function runInspect(source) {
  applyModelsSource(source);
  const result = await runCommandDetailed("headless-core", ["models", "inspect"], 30_000, {
    ...process.env,
    PATH: `${exampleBinDir}${path.delimiter}${process.env.PATH ?? ""}`
  });
  const models = parseInspectModels(result.stdout);
  if (models) {
    inspectedModelsByAgent = models;
  }
  return {
    ...result,
    ...(models ? { agents: toAgentsResponse(models, "inspect") } : {})
  };
}

async function getAvailableModelsForChat(agent) {
  try {
    return await getAvailableModels({ agent });
  } catch (error) {
    return withDefaultModel(inspectedModelsByAgent?.[agent] ?? []);
  }
}

function parseInspectModels(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    if (!parsed || typeof parsed !== "object" || !parsed.models || typeof parsed.models !== "object") {
      return null;
    }

    const models = {};
    for (const agent of agents) {
      const value = parsed.models[agent];
      models[agent] = Array.isArray(value) && value.every((model) => typeof model === "string") ? value : [];
    }
    return models;
  } catch {
    return null;
  }
}

function toAgentsResponse(models, source) {
  const result = {};
  for (const agent of agents) {
    result[agent] = {
      models: withDefaultModel(models[agent] ?? []),
      reasoningEffortOptions: getAvailableReasoningEffortOptions({ agent }),
      source
    };
  }
  return result;
}

function withDefaultModel(models) {
  return [DEFAULT_MODEL_ID, ...models.filter((model) => model !== DEFAULT_MODEL_ID)];
}

function buildPrompt(messages) {
  const transcript = messages
    .map((message) => {
      const role = message.role === "assistant" ? "Assistant" : "User";
      return `${role}: ${asString(message.content)}`;
    })
    .join("\n\n");

  return [
    "You are a concise assistant in a local example chat app.",
    "Answer the latest user message using the conversation transcript.",
    "",
    transcript
  ].join("\n");
}

function runCommandDetailed(command, args, timeoutMs, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Agent command timed out: ${command}`));
    }, timeoutMs);

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function normalizeModelsSource(value) {
  return value === "shared" ? "shared" : "local";
}

// getAvailableModels reads HEADLESS_CORE_MODELS_PATH on every call, so the
// selected source is applied through the environment. "shared" drops the
// override so the library default is used.
function applyModelsSource(source) {
  if (source === "shared") {
    delete process.env.HEADLESS_CORE_MODELS_PATH;
    return sharedModelsPath;
  }
  process.env.HEADLESS_CORE_MODELS_PATH = localModelsPath;
  return localModelsPath;
}

function serveFile(res, filePath, contentType) {
  res.writeHead(200, { "content-type": contentType });
  createReadStream(filePath).pipe(res);
}

function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
  }
  return raw ? JSON.parse(raw) : {};
}

function serializeError(error) {
  if (error instanceof ModelAvailabilityError) {
    return { error: `${error.code}: ${error.message}` };
  }
  if (error instanceof Error) {
    return { error: error.message };
  }
  return { error: String(error) };
}

function asString(value) {
  return typeof value === "string" ? value : "";
}
