#!/usr/bin/env node
// Fake `grok agent stdio` ACP agent for protocol tests: newline-delimited
// JSON-RPC over stdio. Requests are logged to FAKE_LOG with this process's
// pid and argv.
//
// Env knobs:
//   FAKE_AUTH=1     - advertise authMethods in initialize; session/new fails
//                     until authenticate succeeds
//   FAKE_NO_MODELS=1 - omit the "models" block and "model" config option
//   FAKE_NO_MODEL_OPTION=1 - keep the "models" block but omit the "model"
//                     config option (session/set_model is the only channel)
//
// Prompt behaviors (first text block):
//   "NEVER"      - never responds until session/cancel
//   "SLOW"       - responds after 3s
//   "PERM"       - first sends session/request_permission; completes only
//                  after the client answers
//   "KILL"       - exits the process (crash test)
//   "FAILPROMPT" - stopReason "refusal"
//   otherwise    - two agent_message_chunk updates + stopReason "end_turn",
//                  text is "echo:<prompt>"
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const LOG = process.env.FAKE_LOG;
const log = (entry) => {
  if (LOG) {
    appendFileSync(LOG, JSON.stringify({ pid: process.pid, ...entry }) + "\n");
  }
};
log({ method: "_spawn", argv: process.argv.slice(2) });

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const respond = (id, result) => send({ jsonrpc: "2.0", id, result });
const respondError = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

// Per-model effort levels, mirroring the real server's models._meta entries:
// grok-a spans the full range, grok-b is narrower, grok-c does not reason.
const FAKE_MODELS = [
  {
    modelId: "grok-a",
    name: "Grok A",
    description: "Default fake model",
    _meta: {
      supportsReasoningEffort: true,
      reasoningEffort: "high",
      reasoningEfforts: [
        { id: "xhigh", value: "xhigh", label: "Extra High" },
        { id: "high", value: "high", label: "High", default: true },
        { id: "medium", value: "medium", label: "Medium" },
        { id: "low", value: "low", label: "Low" }
      ]
    }
  },
  {
    modelId: "grok-b",
    name: "Grok B",
    _meta: {
      supportsReasoningEffort: true,
      reasoningEffort: "medium",
      reasoningEfforts: [
        { id: "medium", value: "medium", label: "Medium", default: true },
        { id: "low", value: "low", label: "Low" }
      ]
    }
  },
  {
    modelId: "grok-c",
    name: "Grok C",
    _meta: { supportsReasoningEffort: false }
  }
];

const effortLevelsFor = (modelId) =>
  (FAKE_MODELS.find((entry) => entry.modelId === modelId)?._meta.reasoningEfforts ?? []).map(
    (entry) => entry.id
  );

const effortOptionFor = (modelId) => ({
  id: "reasoning_effort",
  name: "Reasoning Effort",
  category: "thought_level",
  type: "select",
  currentValue:
    FAKE_MODELS.find((entry) => entry.modelId === modelId)?._meta.reasoningEffort ?? "high",
  options: effortLevelsFor(modelId).map((level) => ({ value: level, name: level }))
});

const configOptionsFor = (modelId) => [
  ...(process.env.FAKE_NO_MODELS || process.env.FAKE_NO_MODEL_OPTION
    ? []
    : [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: modelId,
          options: FAKE_MODELS.map((entry) => ({ value: entry.modelId, name: entry.name }))
        }
      ]),
  effortOptionFor(modelId)
];

const modelsStateFor = (modelId) => ({
  currentModelId: modelId,
  availableModels: FAKE_MODELS
});

let sessionSeq = 0;
let agentRequestSeq = 9000;
let authenticated = false;
const sessions = new Map(); // sessionId -> { configOptions, models }
const pendingPrompts = new Map(); // sessionId -> { id, timer }
const agentRequests = new Map(); // request id -> resolve

const chunk = (sessionId, text) =>
  notify("session/update", {
    sessionId,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } }
  });

const configUpdate = (sessionId, configOptions) =>
  notify("session/update", {
    sessionId,
    update: { sessionUpdate: "config_option_update", configOptions }
  });

const finishPrompt = (sessionId) => {
  const pending = pendingPrompts.get(sessionId);
  if (!pending) {
    return;
  }
  pendingPrompts.delete(sessionId);
  respond(pending.id, { stopReason: "end_turn" });
};

readline
  .createInterface({ input: process.stdin })
  .on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const { id, method, params = {} } = message;

    // Responses to agent-initiated requests (e.g. session/request_permission).
    if (!method && id !== undefined && id !== null) {
      const resolve = agentRequests.get(id);
      if (resolve) {
        agentRequests.delete(id);
        log({ method: "_response_to_agent", id, result: message.result });
        resolve(message.result);
      }
      return;
    }
    if (method) {
      log({ method, params, id });
    }

    switch (method) {
      case "initialize":
        respond(id, {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: false, audio: false, embeddedContext: true },
            sessionCapabilities: { list: {}, resume: {}, close: {} }
          },
          authMethods: process.env.FAKE_AUTH
            ? [
                { id: "cached_token", name: "cached_token", description: "Cached token" },
                { id: "grok.com", name: "Grok", description: "Sign in with Grok" }
              ]
            : [],
          agentInfo: { name: "fake-grok", version: "0.0.0" },
          _meta: { defaultAuthMethodId: "cached_token" }
        });
        return;
      case "authenticate":
        authenticated = true;
        respond(id, {});
        return;
      case "session/new": {
        if (process.env.FAKE_AUTH && !authenticated) {
          respondError(id, -32000, "auth_required");
          return;
        }
        const sessionId = `grok-sess-${++sessionSeq}`;
        sessions.set(sessionId, {
          configOptions: configOptionsFor("grok-a"),
          models: modelsStateFor("grok-a")
        });
        const session = sessions.get(sessionId);
        respond(id, {
          sessionId,
          ...(process.env.FAKE_NO_MODELS ? {} : { models: session.models }),
          configOptions: session.configOptions
        });
        return;
      }
      case "session/prompt": {
        const sessionId = params.sessionId;
        const text = (params.prompt ?? []).map((block) => block.text ?? "").join("");
        if (text === "KILL") {
          process.exit(3);
        }
        if (text === "NEVER") {
          pendingPrompts.set(sessionId, { id });
          return;
        }
        if (text === "PERM") {
          const requestId = ++agentRequestSeq;
          send({
            jsonrpc: "2.0",
            id: requestId,
            method: "session/request_permission",
            params: {
              sessionId,
              toolCall: { toolCallId: "tc-1", title: "write output.txt", kind: "edit", status: "pending" },
              options: [
                { optionId: "allow", name: "Allow once", kind: "allow_once" },
                { optionId: "reject", name: "Reject", kind: "reject_once" }
              ]
            }
          });
          agentRequests.set(requestId, () => {
            chunk(sessionId, "perm-answered");
            finishPrompt(sessionId);
          });
          pendingPrompts.set(sessionId, { id });
          return;
        }
        if (text === "FAILPROMPT") {
          respond(id, { stopReason: "refusal" });
          return;
        }
        const timer = setTimeout(
          () => {
            const echo = `echo:${text}`;
            chunk(sessionId, echo.slice(0, 5));
            chunk(sessionId, echo.slice(5));
            finishPrompt(sessionId);
          },
          text === "SLOW" ? 3000 : 5
        );
        pendingPrompts.set(sessionId, { id, timer });
        return;
      }
      case "session/cancel": {
        const pending = pendingPrompts.get(params.sessionId);
        if (pending) {
          pendingPrompts.delete(params.sessionId);
          if (pending.timer) {
            clearTimeout(pending.timer);
          }
          respond(pending.id, { stopReason: "cancelled" });
        }
        return;
      }
      case "session/set_config_option": {
        const session = sessions.get(params.sessionId);
        if (!session) {
          respondError(id, -32602, "unknown session");
          return;
        }
        const option = session.configOptions.find((entry) => entry.id === params.configId);
        if (!option || !option.options.some((entry) => entry.value === params.value)) {
          respondError(id, -32602, `Invalid value "${params.value}" for config option '${params.configId}'`);
          return;
        }
        option.currentValue = params.value;
        if (option.id === "model") {
          // The effort option tracks the selected model's levels, like the
          // real server.
          session.models.currentModelId = params.value;
          const effort = session.configOptions.find((entry) => entry.id === "reasoning_effort");
          if (effort) {
            effort.options = effortLevelsFor(params.value).map((level) => ({
              value: level,
              name: level
            }));
            effort.currentValue =
              FAKE_MODELS.find((entry) => entry.modelId === params.value)?._meta.reasoningEffort ??
              effort.currentValue;
          }
        }
        respond(id, { configOptions: session.configOptions });
        configUpdate(params.sessionId, session.configOptions);
        return;
      }
      case "session/set_model": {
        const session = sessions.get(params.sessionId);
        if (!session) {
          respondError(id, -32602, "unknown session");
          return;
        }
        if (!FAKE_MODELS.some((entry) => entry.modelId === params.modelId)) {
          respondError(id, -32602, `unknown model: ${params.modelId}`);
          return;
        }
        session.models.currentModelId = params.modelId;
        const effort = session.configOptions.find((entry) => entry.id === "reasoning_effort");
        if (effort) {
          effort.options = effortLevelsFor(params.modelId).map((level) => ({
            value: level,
            name: level
          }));
          effort.currentValue =
            FAKE_MODELS.find((entry) => entry.modelId === params.modelId)?._meta.reasoningEffort ??
            effort.currentValue;
        }
        respond(id, { _meta: { model: { Ok: params.modelId } } });
        configUpdate(params.sessionId, session.configOptions);
        return;
      }
      case "session/close":
        sessions.delete(params.sessionId);
        respond(id, {});
        return;
      case "session/delete":
        sessions.delete(params.sessionId);
        respond(id, {});
        return;
      default:
        if (id !== undefined && id !== null) {
          respondError(id, -32601, `unknown method: ${method}`);
        }
    }
  });
