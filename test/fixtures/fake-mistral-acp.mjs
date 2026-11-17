#!/usr/bin/env node
// Vibe 3.1 ACP: model/mode/thinking config options, without a legacy models block.
import { appendFileSync } from "node:fs";
import readline from "node:readline";
const log = (entry) => process.env.FAKE_LOG && appendFileSync(process.env.FAKE_LOG,
  JSON.stringify({ pid: process.pid, ...entry }) + "\n");
log({ method: "_spawn", argv: process.argv.slice(2) });
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
const reply = (id, result) => send({ id, result });
const update = (sessionId, value) => send({ method: "session/update", params: { sessionId, update: value } });
const chunk = (sessionId, text) => update(sessionId, {
  sessionUpdate: "agent_message_chunk", content: { type: "text", text }
});
const levels = (model) => model === "small" ? ["off"] : ["off", "low", "high"];
const select = (id, currentValue, values) => ({ id, name: id, category: id,
  type: "select", currentValue, options: values.map((value) => ({ value, name: value })) });
const config = (model = "devstral") => [
  select("mode", "accept-edits", ["ask", "accept-edits", "auto-approve"]),
  select("model", model, ["devstral", "small"]),
  select("thinking", "off", levels(model))
];
let sequence = 0;
const sessions = new Map();
const pending = new Map();
const permissions = new Map();
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params = {}, result } = JSON.parse(line);
  if (!method) {
    log({ method: "_permission", result });
    const sessionId = permissions.get(id);
    if (sessionId) { chunk(sessionId, "permission answered"); reply(pending.get(sessionId), { stopReason: "end_turn" }); pending.delete(sessionId); }
    return;
  }
  log({ method, params });
  switch (method) {
    case "initialize":
      reply(id, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } },
        authMethods: [{ id: "browser", name: "Sign in" }] }); return;
    case "authenticate":
      throw new Error("A headless client must not launch browser authentication");
    case "session/new": {
      const sessionId = `vibe-${++sequence}`;
      sessions.set(sessionId, config());
      reply(id, { sessionId, configOptions: sessions.get(sessionId) }); return;
    }
    case "session/set_config_option": {
      const options = sessions.get(params.sessionId);
      const option = options.find((entry) => entry.id === params.configId);
      if (!option?.options.some((entry) => entry.value === params.value)) {
        send({ id, error: { code: -32602, message: "Unsupported option" } }); return;
      }
      option.currentValue = params.value;
      if (option.id === "model") options[2] = select("thinking", "off", levels(params.value));
      reply(id, { configOptions: options }); return;
    }
    case "session/prompt": {
      const { sessionId } = params;
      const text = params.prompt[0].text;
      if (text === "KILL") process.exit(2);
      if (text === "NEVER") { pending.set(sessionId, id); return; }
      if (text === "FAIL") { reply(id, { stopReason: "refusal" }); return; }
      if (text === "PERM") {
        pending.set(sessionId, id); permissions.set(9000, sessionId);
        send({ id: 9000, method: "session/request_permission", params: { sessionId,
          toolCall: { toolCallId: "write", title: "write", kind: "edit", status: "pending" },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" }] } }); return;
      }
      update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
      chunk(sessionId, "echo:"); chunk(sessionId, text);
      reply(id, { stopReason: "end_turn" }); return;
    }
    case "session/cancel":
      if (pending.has(params.sessionId)) reply(pending.get(params.sessionId), { stopReason: "cancelled" });
      pending.delete(params.sessionId); return;
    case "session/close": sessions.delete(params.sessionId); reply(id, {}); return;
    default: send({ id, error: { code: -32601, message: "Unsupported method" } });
  }
});
