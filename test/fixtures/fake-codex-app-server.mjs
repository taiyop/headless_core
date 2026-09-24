#!/usr/bin/env node
// Fake `codex app-server` for protocol tests: newline-delimited JSON-RPC over
// stdio. Every request is logged as JSON lines to FAKE_LOG (including this
// process's pid) so tests can assert on the wire protocol and process reuse.
//
// Prompt behaviors:
//   "NEVER"    - never completes until turn/interrupt
//   "SLOW"     - completes after 3s
//   "FAILTURN" - completes with status "failed"
//   otherwise  - two item/agentMessage/delta chunks + turn/completed with
//                a final agentMessage item containing "echo:<prompt>"
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const LOG = process.env.FAKE_LOG;
const log = (entry) => {
  if (LOG) {
    appendFileSync(LOG, JSON.stringify({ pid: process.pid, ...entry }) + "\n");
  }
};

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const respond = (id, result) => send({ id, result });
const notify = (method, params) => send({ method, params });

let threadSeq = 0;
let turnSeq = 0;
const inFlight = new Map(); // turnId -> { threadId, timer }

const completeTurn = (threadId, turnId, status, extra = {}) =>
  notify("turn/completed", { threadId, turn: { id: turnId, status, items: [], ...extra } });

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
    if (method) {
      log({ method, params, id });
    }

    switch (method) {
      case "initialize":
        respond(id, {
          userAgent: "fake-codex/0.0.0",
          codexHome: "/tmp",
          platformFamily: "unix",
          platformOs: "test"
        });
        return;
      case "initialized":
        return;
      case "thread/start": {
        if (params.model === "__crash__") {
          process.exit(2);
        }
        const threadId = `thread-${++threadSeq}`;
        respond(id, {
          thread: { id: threadId },
          model: params.model ?? "default-model",
          modelProvider: "fake",
          reasoningEffort: "low",
          cwd: params.cwd ?? "/tmp",
          approvalPolicy: params.approvalPolicy,
          sandbox: params.sandbox
        });
        return;
      }
      case "thread/unsubscribe":
        respond(id, { status: "unsubscribed" });
        return;
      case "model/list":
        respond(id, {
          data: [
            {
              id: "fake-m1",
              model: "fake-m1",
              displayName: "Fake M1",
              description: "first model",
              hidden: false,
              supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
              defaultReasoningEffort: "low"
            },
            {
              id: "fake-m2",
              model: "fake-m2",
              displayName: "Fake M2",
              description: "second model",
              hidden: false,
              supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
              defaultReasoningEffort: "medium"
            },
            {
              id: "fake-m3",
              model: "fake-m3",
              displayName: "Fake M3",
              description: "model with an explicit off level",
              hidden: false,
              supportedReasoningEfforts: [
                { reasoningEffort: "none" },
                { reasoningEffort: "minimal" },
                { reasoningEffort: "low" }
              ],
              defaultReasoningEffort: "minimal"
            }
          ],
          nextCursor: null
        });
        return;
      case "turn/start": {
        const turnId = `turn-${++turnSeq}`;
        const threadId = params.threadId;
        const prompt = (params.input ?? []).map((input) => input.text ?? "").join("");
        respond(id, { turn: { id: turnId, status: "inProgress", items: [] } });

        if (prompt === "KILL") {
          process.exit(3);
        }
        if (prompt === "NEVER") {
          inFlight.set(turnId, { threadId });
          return;
        }
        const timer = setTimeout(
          () => {
            inFlight.delete(turnId);
            if (prompt === "FAILTURN") {
              completeTurn(threadId, turnId, "failed", { error: { message: "turn exploded" } });
              return;
            }
            const text = `echo:${prompt}`;
            notify("item/agentMessage/delta", {
              threadId,
              turnId,
              itemId: `item-${turnId}`,
              delta: text.slice(0, 5)
            });
            notify("item/agentMessage/delta", {
              threadId,
              turnId,
              itemId: `item-${turnId}`,
              delta: text.slice(5)
            });
            completeTurn(threadId, turnId, "completed", {
              items: [{ type: "agentMessage", id: `item-${turnId}`, text, phase: "final_answer" }]
            });
          },
          prompt === "SLOW" ? 3000 : 5
        );
        inFlight.set(turnId, { threadId, timer });
        return;
      }
      case "turn/interrupt": {
        const pending = inFlight.get(params.turnId);
        if (pending) {
          inFlight.delete(params.turnId);
          if (pending.timer) {
            clearTimeout(pending.timer);
          }
          completeTurn(pending.threadId, params.turnId, "interrupted");
        }
        respond(id, {});
        return;
      }
      default:
        if (id !== undefined && id !== null) {
          send({ id, error: { code: -32601, message: `unknown method: ${method}` } });
        }
    }
  });
