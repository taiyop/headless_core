#!/usr/bin/env node
// Fake `agy_acp_server` ACP agent for protocol tests: newline-delimited
// JSON-RPC over stdio. Requests are logged to FAKE_LOG with this process's
// pid.
//
// Env knobs:
//   FAKE_AUTH=1       - advertise authMethods in initialize; session/new fails
//                       until authenticate succeeds
//   FAKE_MODES_ONLY=1 - omit the "mode" config option; mode changes only via
//                       session/set_mode
//   FAKE_NO_EFFORT=1  - omit the "effort" config option
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

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const respond = (id, result) => send({ jsonrpc: "2.0", id, result });
const respondError = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

// Matches the modes the real server advertises (default / auto_edit / yolo).
const FAKE_MODES = [
  { value: "default", name: "Default" },
  { value: "auto_edit", name: "Auto Edit" },
  { value: "yolo", name: "YOLO" }
];

const modeOption = {
  id: "mode",
  name: "Mode",
  category: "mode",
  type: "select",
  currentValue: "default",
  options: FAKE_MODES
};

const modelOption = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "gem-3",
  options: [
    { value: "gem-3", name: "Gem 3" },
    { value: "m-plain", name: "Plain Model" },
    { value: "gem-1", name: "Gem 1" },
    { value: "gem-1-low", name: "Gem 1 Low" },
    { value: "gem-1-high", name: "Gem 1 High" },
    { value: "gem-2-none", name: "Gem 2 (no thinking)" },
    { value: "gem-2-medium", name: "Gem 2 Medium" }
  ]
};

const effortOption = {
  id: "effort",
  name: "Reasoning Effort",
  category: "effort",
  type: "select",
  currentValue: "medium",
  options: [
    { value: "low", name: "Low" },
    { value: "medium", name: "Medium" },
    { value: "high", name: "High" }
  ]
};

const configOptions = () => [
  ...(process.env.FAKE_MODES_ONLY ? [] : [modeOption]),
  modelOption,
  ...(process.env.FAKE_NO_EFFORT ? [] : [effortOption])
].map((option) => ({ ...option, options: option.options.map((entry) => ({ ...entry })) }));

const modesState = () => ({
  currentModeId: "default",
  availableModes: FAKE_MODES.map((entry) => ({ id: entry.value, name: entry.name }))
});

let sessionSeq = 0;
let agentRequestSeq = 9000;
let authenticated = false;
const sessions = new Map(); // sessionId -> { configOptions, modes }
const pendingPrompts = new Map(); // sessionId -> { id, timer }
const agentRequests = new Map(); // request id -> resolve

const chunk = (sessionId, text) =>
  notify("session/update", {
    sessionId,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } }
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
            promptCapabilities: { image: false, audio: false, embeddedContext: false }
          },
          authMethods: process.env.FAKE_AUTH
            ? [{ id: "oauth-personal", name: "Sign in with Google" }]
            : [],
          agentInfo: { name: "fake-agy-acp-server", version: "0.0.0" }
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
        const sessionId = `agy-sess-${++sessionSeq}`;
        sessions.set(sessionId, { configOptions: configOptions(), modes: modesState() });
        const session = sessions.get(sessionId);
        respond(id, {
          sessionId,
          modes: session.modes,
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
              toolCall: { toolCallId: "tc-1", title: "write output.png", kind: "edit", status: "pending" },
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
        respond(id, { configOptions: session.configOptions });
        return;
      }
      case "session/set_mode": {
        const session = sessions.get(params.sessionId);
        if (!session) {
          respondError(id, -32602, "unknown session");
          return;
        }
        if (!session.modes.availableModes.some((entry) => entry.id === params.modeId)) {
          respondError(id, -32602, `Invalid mode "${params.modeId}"`);
          return;
        }
        session.modes.currentModeId = params.modeId;
        respond(id, {});
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
