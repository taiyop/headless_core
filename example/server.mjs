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
// Persistent transports per provider (see "Persistent sessions" in the main
// README): codex app-server, agy_acp_server, and devin acp keep one process
// alive across runs.
const transportsByAgent = {
  codex: ["cli", "app-server"],
  agy: ["cli", "acp"],
  devin: ["cli", "acp"]
};
const exampleBinDir = path.join(__dirname, "bin");
let inspectedModelsByAgent = null;
// key: `${agent}:${transport}` -> Promise<{ session, hasHistory }>. The promise
// is stored so concurrent first sends share one createSession call.
const sessions = new Map();
// Models reported by live sessions (session.getAvailableModels()), keyed by
// agent. Merged into the config-file list so runtime-only ids stay selectable.
const runtimeModelsByAgent = new Map();
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

    if (req.method === "POST" && url.pathname === "/api/session/reset") {
      const body = await readJson(req);
      return json(res, 200, await resetSession(body));
    }

    if (req.method === "POST" && url.pathname === "/api/chat") {
      const body = await readJson(req);
      return json(res, 200, await runChat(body));
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

// Close persistent sessions so app-server/acp child processes exit with us.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void shutdownSessions().finally(() => process.exit(0));
  });
}

async function shutdownSessions() {
  const pending = [...sessions.values()];
  sessions.clear();
  const entries = await Promise.all(pending.map((entry) => entry.catch(() => undefined)));
  await Promise.all(
    entries.filter(Boolean).map((entry) => entry.session.close().catch(() => undefined))
  );
  await headless.shutdown().catch(() => undefined);
}

async function loadModelsByAgent() {
  const result = {};
  for (const agent of agents) {
    const reasoningEffortOptions = getAvailableReasoningEffortOptions({ agent });
    const transports = transportsByAgent[agent] ?? ["cli"];
    try {
      result[agent] = {
        models: mergeRuntimeModels(agent, await getAvailableModels({ agent })),
        reasoningEffortOptions,
        transports
      };
    } catch (error) {
      const inspectedModels = inspectedModelsByAgent?.[agent];
      result[agent] = {
        models: mergeRuntimeModels(agent, inspectedModels ?? []),
        reasoningEffortOptions,
        transports,
        ...(inspectedModels ? { source: "inspect" } : { error: serializeError(error).error })
      };
    }
  }
  return result;
}

async function runChat(body) {
  const agent = asString(body.agent);
  const transport = asString(body.transport) || "cli";
  const model = asString(body.model);
  const rawReasoningEffort = asString(body.reasoningEffort);
  const reasoningEffort = rawReasoningEffort === DEFAULT_REASONING_EFFORT_ID ? "" : rawReasoningEffort;
  const messages = Array.isArray(body.messages) ? body.messages : [];

  if (!agents.includes(agent)) {
    throw new Error(`Unsupported agent: ${agent}`);
  }
  const supportedTransports = transportsByAgent[agent] ?? ["cli"];
  if (!supportedTransports.includes(transport)) {
    throw new Error(`Unsupported transport for ${agent}: ${transport} (supported: ${supportedTransports.join(", ")})`);
  }
  if (!model) {
    throw new Error("Model is required");
  }
  // Effort values are validated by the library with detailed per-model
  // errors (EffortError INVALID_EFFORT / UNSUPPORTED_EFFORT), which are
  // surfaced to the UI as the chat error.

  applyModelsSource(asString(body.source));
  const availableModels = await getAvailableModelsForChat(agent);
  if (!availableModels.includes(model)) {
    throw new Error(`Model "${model}" is not available for ${agent}`);
  }

  if (transport !== "cli") {
    return runSessionChat({ agent, transport, model, reasoningEffort, messages });
  }

  const prompt = buildPrompt(messages);
  const reply = await headless.run({
    agent: {
      provider: agent,
      model,
      ...(reasoningEffort ? { reasoningEffort } : {})
    },
    prompt
  });
  return { reply };
}

/**
 * One-shot chat over a persistent transport. Sessions are kept per
 * agent+transport so the remote conversation continues across messages: the
 * first turn of a new session carries the transcript for context, later turns
 * send only the latest user message.
 */
async function runSessionChat({ agent, transport, model, reasoningEffort, messages }) {
  const key = `${agent}:${transport}`;
  let entryPromise = sessions.get(key);
  let created = false;
  if (!entryPromise) {
    created = true;
    entryPromise = headless
      .createSession({
        agent: {
          provider: agent,
          transport,
          model,
          ...(reasoningEffort ? { reasoningEffort } : {})
        }
      })
      .then((session) => ({ session, hasHistory: false }));
    sessions.set(key, entryPromise);
    // Failed startups must not poison later sends.
    entryPromise.catch(() => {
      if (sessions.get(key) === entryPromise) {
        sessions.delete(key);
      }
    });
  }
  const entry = await entryPromise;
  if (!created) {
    // Applies from the next turn without restarting the runtime. "" restores
    // the provider default effort.
    await entry.session.setModel(model, reasoningEffort);
  }

  const prompt = entry.hasHistory ? latestUserMessage(messages) : buildPrompt(messages);
  // Mark before running so a concurrent send on a fresh session does not also
  // transmit the full transcript.
  entry.hasHistory = true;
  try {
    const reply = await entry.session.run({ prompt });
    const models = await sessionModelIds(entry.session);
    if (models.length > 0) {
      runtimeModelsByAgent.set(agent, models);
    }
    return { reply, sessionId: entry.session.id, models };
  } catch (error) {
    // A failed turn may leave the runtime dead; drop the session so the next
    // message starts a fresh conversation.
    if (sessions.get(key) === entryPromise) {
      sessions.delete(key);
    }
    await entry.session.close().catch(() => undefined);
    throw error;
  }
}

async function resetSession(body) {
  const agent = asString(body.agent);
  const transport = asString(body.transport) || "cli";
  const key = `${agent}:${transport}`;
  const entryPromise = sessions.get(key);
  const entry = await entryPromise?.catch(() => undefined);
  if (!entry) {
    return { reset: false };
  }
  try {
    await entry.session.reset();
    entry.hasHistory = false;
    return { reset: true, sessionId: entry.session.id };
  } catch (error) {
    if (sessions.get(key) === entryPromise) {
      sessions.delete(key);
    }
    await entry.session.close().catch(() => undefined);
    throw error;
  }
}

async function sessionModelIds(session) {
  try {
    const candidates = await session.getAvailableModels();
    return candidates.map((candidate) => candidate.id).filter((id) => typeof id === "string" && id);
  } catch {
    return [];
  }
}

function latestUserMessage(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      return asString(messages[index].content);
    }
  }
  return "";
}

function mergeRuntimeModels(agent, models) {
  const runtimeModels = runtimeModelsByAgent.get(agent) ?? [];
  return [...models, ...runtimeModels.filter((model) => !models.includes(model))];
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
    return mergeRuntimeModels(agent, await getAvailableModels({ agent }));
  } catch (error) {
    return mergeRuntimeModels(agent, withDefaultModel(inspectedModelsByAgent?.[agent] ?? []));
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
      models: mergeRuntimeModels(agent, withDefaultModel(models[agent] ?? [])),
      reasoningEffortOptions: getAvailableReasoningEffortOptions({ agent }),
      transports: transportsByAgent[agent] ?? ["cli"],
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
