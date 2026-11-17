import {
  acpToolKind,
  describeToolUse,
  isRecord,
  outputText,
  planStatus,
  toLocations,
  toolTitle,
  truncateOutput,
  truncateTitle,
  type ProgressUpdate
} from "./progress.js";
import type { ToolUseEvent, ToolUseStatus } from "./types.js";

/** What has been seen so far for one ACP tool call (tool_call + merged updates). */
type ToolCallState = {
  title?: string;
  kind?: unknown;
  status?: string;
  locations?: unknown;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: unknown;
  /** title/rawInput of the last `started` sent, to detect changes. */
  startedKey?: string;
  finished: boolean;
};

const TOOL_CALL_FIELDS = ["title", "kind", "status", "locations", "rawInput", "rawOutput", "content"] as const;

/**
 * Converts ACP `session/update` notifications into ProgressUpdates. Shared by
 * the agy, grok and devin ACP sessions; one instance per turn.
 *
 * - `agent_message_chunk` -> `partialOutput`
 * - `agent_thought_chunk` -> `thought`
 * - `tool_call` / `tool_call_update` -> `toolUse` (updates are merged per
 *   toolCallId; an update may arrive before its tool_call)
 * - `plan` -> `plan`
 *
 * Everything else (config/mode/command updates) yields nothing.
 */
export class AcpProgressConverter {
  private readonly calls = new Map<string, ToolCallState>();

  convert(update: unknown): ProgressUpdate[] {
    if (!isRecord(update)) {
      return [];
    }
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = contentText(update.content);
        return text ? [{ partialOutput: text }] : [];
      }
      case "agent_thought_chunk": {
        const text = contentText(update.content);
        return text ? [{ thought: text }] : [];
      }
      case "tool_call":
      case "tool_call_update":
        return this.toolCall(update);
      case "plan": {
        if (!Array.isArray(update.entries)) {
          return [];
        }
        return [
          {
            plan: update.entries.filter(isRecord).map((entry) => ({
              content: String(entry.content ?? ""),
              status: planStatus(entry.status),
              ...(typeof entry.priority === "string" ? { priority: entry.priority } : {})
            }))
          }
        ];
      }
      default:
        return [];
    }
  }

  /** Drops per-call state; called when the turn ends. */
  reset(): void {
    this.calls.clear();
  }

  private toolCall(update: Record<string, unknown>): ProgressUpdate[] {
    const id = typeof update.toolCallId === "string" ? update.toolCallId : "";
    let state = this.calls.get(id);
    if (!state) {
      state = { finished: false };
      this.calls.set(id, state);
    }
    if (state.finished) {
      return [];
    }
    // null/undefined fields keep what an earlier update reported. So do empty
    // arrays: grok resends `locations: []` / `content: []` on later updates.
    for (const field of TOOL_CALL_FIELDS) {
      const value = update[field];
      if (value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0)) {
        (state as Record<string, unknown>)[field] = value;
      }
    }

    const events: ProgressUpdate[] = [];
    const startedKey = JSON.stringify([state.title ?? null, state.rawInput ?? null]);
    if (state.startedKey !== startedKey) {
      state.startedKey = startedKey;
      events.push(toolUpdate(toolEvent(id, state, "started")));
    }
    const terminal = terminalStatus(state.status);
    if (terminal) {
      state.finished = true;
      events.push(toolUpdate({ ...toolEvent(id, state, terminal), ...outputField(state) }));
    }
    return events;
  }
}

function toolEvent(id: string, state: ToolCallState, status: ToolUseStatus): ToolUseEvent {
  const kind = state.kind === undefined ? undefined : acpToolKind(state.kind);
  const title = state.title ? truncateTitle(state.title) : toolTitle(state.rawInput);
  const locations = toLocations(state.locations);
  return {
    id,
    name: state.title || (typeof state.kind === "string" ? state.kind : "") || "tool",
    status,
    ...(kind ? { kind } : {}),
    ...(title ? { title } : {}),
    ...(locations ? { locations } : {}),
    ...(status === "started" && state.rawInput !== undefined ? { input: state.rawInput } : {})
  };
}

function toolUpdate(toolUse: ToolUseEvent): ProgressUpdate {
  return { toolUse, message: describeToolUse(toolUse) };
}

function terminalStatus(status: string | undefined): ToolUseStatus | undefined {
  return status === "completed" ? "completed" : status === "failed" ? "failed" : undefined;
}

/** `content` text blocks joined, else `rawOutput` (strings as-is, objects as JSON). */
function outputField(state: ToolCallState): { output?: string } {
  const text = Array.isArray(state.content)
    ? state.content
        .map((entry) => (isRecord(entry) && entry.type === "content" ? contentText(entry.content) : ""))
        .filter(Boolean)
        .join("\n")
    : "";
  const output = text || outputText(state.rawOutput);
  return output ? { output: truncateOutput(output) } : {};
}

function contentText(content: unknown): string {
  return isRecord(content) && content.type === "text" && typeof content.text === "string" ? content.text : "";
}
