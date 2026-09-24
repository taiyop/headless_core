#!/usr/bin/env node
// Fake `devin acp` ACP agent for protocol tests: newline-delimited JSON-RPC
// over stdio. Requests are logged to FAKE_LOG with this process's pid.
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

const configOptions = () => [
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: "accept-edits",
    options: [
      { value: "accept-edits", name: "Code" },
      { value: "ask", name: "Ask" }
    ]
  },
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "m-a",
    options: [
      { value: "m-a", name: "Model A" },
      { value: "m-b", name: "Model B" },
      { value: "fam-low", name: "Fam Low" },
      { value: "fam-medium", name: "Fam Medium" },
      { value: "swe-2-high", name: "SWE-2 High" },
      { value: "gpt-5-6-sol-medium", name: "GPT 5.6 Sol Medium" },
      { value: "glm-5-2", name: "GLM 5.2" },
      { value: "gpt-5-4-low", name: "GPT 5.4 Low" },
      { value: "gpt-5-4-none", name: "GPT 5.4 (no reasoning)" },
      { value: "claude-opus-4-6", name: "Claude Opus 4.6" },
      { value: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 Thinking" }
    ]
  },
  {
    id: "thought_level",
    name: "Thought Level",
    category: "thought_level",
    type: "select",
    currentValue: "high",
    options: [
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" }
    ]
  }
];

let sessionSeq = 0;
let agentRequestSeq = 9000;
const sessions = new Map(); // sessionId -> { configOptions }
const pendingPrompts = new Map(); // sessionId -> { id, timer }
const agentRequests = new Map(); // request id -> resolve

const chunk = (sessionId, text) =>
  notify("session/update", {
    sessionId,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } }
  });

const finishPrompt = (sessionId, text) => {
  const pending = pendingPrompts.get(sessionId);
  if (!pending) {
    return;
  }
  pendingPrompts.delete(sessionId);
  respond(pending.id, { stopReason: "end_turn" });
  void text;
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
          agentCapabilities: {},
          agentInfo: { name: "fake-devin", version: "0.0.0" }
        });
        return;
      case "session/new": {
        const sessionId = `sess-${++sessionSeq}`;
        sessions.set(sessionId, { configOptions: configOptions() });
        respond(id, {
          sessionId,
          modes: {
            currentModeId: "accept-edits",
            availableModes: [
              { id: "accept-edits", name: "Code" },
              { id: "ask", name: "Ask" }
            ]
          },
          configOptions: sessions.get(sessionId).configOptions
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
              toolCall: { toolCallId: "tc-1", title: "run rm -rf", kind: "execute", status: "pending" },
              options: [
                { optionId: "allow", name: "Allow", kind: "allow_once" },
                { optionId: "reject", name: "Reject", kind: "reject_once" }
              ]
            }
          });
          agentRequests.set(requestId, () => {
            chunk(sessionId, "perm-answered");
            finishPrompt(sessionId, text);
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
            finishPrompt(sessionId, text);
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
        if (session) {
          for (const option of session.configOptions) {
            if (option.id === params.configId) {
              option.currentValue = params.value;
            }
          }
          respond(id, { configOptions: session.configOptions });
          return;
        }
        respondError(id, -32602, "unknown session");
        return;
      }
      case "session/close":
        // Like real `devin acp`: close is not implemented, delete is.
        respondError(id, -32601, "Method not found");
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
