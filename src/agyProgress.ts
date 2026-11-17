import {
  agyToolKind,
  describeToolUse,
  isRecord,
  outputText,
  toolTitle,
  truncateOutput,
  type ProgressUpdate
} from "./progress.js";
import type { ToolUseEvent, ToolUseStatus } from "./types.js";

/** Tool parameters that name the file a step reads or changes. */
const PATH_FIELDS = ["AbsolutePath", "Path", "TargetFile", "FilePath", "absolute_path", "file_path"] as const;

/**
 * Converts `agy --output-format stream-json` events (agy 1.4.x). The schema
 * is unpublished; this follows recorded output:
 *
 * - `step_update` with `step_type: "agent_response"` carries `text_delta`
 * - `step_update` with `step_type: "tool"` carries `tool_name`/`tool_info`
 *   and a `state` (`ACTIVE` while running, `DONE` when finished)
 * - `result.response` is the final answer, `result.status` is `SUCCESS`
 *
 * agy reports only thinking token counts, never thinking text, so no
 * `thought` is produced.
 */
export class AgyStreamConverter {
  private readonly startedKeys = new Map<string, string>();
  private readonly finished = new Set<string>();
  private result: Record<string, unknown> | undefined;
  private text = "";

  convert(message: Record<string, unknown>): ProgressUpdate[] {
    if (message.event === "result" && isRecord(message.result)) {
      this.result = message.result;
      return [];
    }
    if (message.event !== "step_update" || !isRecord(message.step_update)) {
      return [];
    }
    const step = message.step_update;
    if (step.step_type === "agent_response") {
      if (typeof step.text_delta === "string" && step.text_delta) {
        this.text += step.text_delta;
        return [{ partialOutput: step.text_delta }];
      }
      return [];
    }
    if (step.step_type === "tool") {
      return this.tool(step);
    }
    return [];
  }

  error(): string | undefined {
    const result = this.result;
    if (!result || result.status === "SUCCESS") {
      return undefined;
    }
    const detail = [result.error, result.message, result.response].find((value) => typeof value === "string" && value);
    return detail ? String(detail) : `agy run ${String(result.status ?? "failed").toLowerCase()}`;
  }

  output(): string | undefined {
    if (!this.result) {
      return undefined;
    }
    return (typeof this.result.response === "string" ? this.result.response : this.text).trim();
  }

  private tool(step: Record<string, unknown>): ProgressUpdate[] {
    const id = `step-${String(step.step_index ?? "")}`;
    if (this.finished.has(id)) {
      return [];
    }
    const info = isRecord(step.tool_info) ? step.tool_info : {};
    const name = String(step.tool_name ?? info.name ?? "");
    const input = info.parameters;
    const title = toolTitle(input);
    const path = isRecord(input) ? PATH_FIELDS.map((field) => input[field]).find((value) => typeof value === "string") : undefined;
    const base: ToolUseEvent = {
      id,
      name,
      status: "started",
      kind: agyToolKind(name),
      ...(title ? { title } : {}),
      ...(typeof path === "string" && path ? { locations: [{ path }] } : {})
    };

    const updates: ProgressUpdate[] = [];
    const key = JSON.stringify([title ?? null, input ?? null]);
    if (this.startedKeys.get(id) !== key) {
      this.startedKeys.set(id, key);
      updates.push(toolUpdate({ ...base, ...(input !== undefined ? { input } : {}) }));
    }
    const status = terminalStatus(step.state);
    if (status) {
      this.finished.add(id);
      const output = outputText(info.output);
      updates.push(toolUpdate({ ...base, status, ...(output ? { output: truncateOutput(output) } : {}) }));
    }
    return updates;
  }
}

function toolUpdate(toolUse: ToolUseEvent): ProgressUpdate {
  return { toolUse, message: describeToolUse(toolUse) };
}

/** `DONE` completes; error/cancel-like states fail; anything else is still running. */
function terminalStatus(state: unknown): ToolUseStatus | undefined {
  const value = typeof state === "string" ? state.toUpperCase() : "";
  if (value === "DONE" || value === "COMPLETED") {
    return "completed";
  }
  if (/DENIED|REJECT/.test(value)) {
    return "denied";
  }
  if (/ERROR|FAIL|CANCEL/.test(value)) {
    return "failed";
  }
  return undefined;
}
