import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { createServer } from "node:http";
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
const port = Number(process.env.PORT ?? 4173);
const host = process.env.HOST ?? "127.0.0.1";

process.env.HEADLESS_CORE_MODELS_PATH ??= path.join(__dirname, "models.json");

const agents = ["codex", "claude", "agy", "grok"];
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
      return json(res, 200, { agents: await loadModelsByAgent() });
    }

    if (req.method === "POST" && url.pathname === "/api/inspect") {
      const result = await runInspect();
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

server.listen(port, host, () => {
  console.log(`Example chat running at http://${host}:${port}`);
  console.log(`Using models config: ${process.env.HEADLESS_CORE_MODELS_PATH}`);
});

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

async function runInspect() {
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
