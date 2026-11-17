import type { CliStreamConverter } from "./headlessCore.js";
import { TOOL_OUTPUT_LIMIT, TOOL_TITLE_LIMIT, type ProgressUpdate } from "./progress.js";
import type { ToolKind, ToolUseEvent } from "./types.js";

/** Completed history entries from `vibe --output streaming` (Vibe 3.1). */
export class MistralStreamConverter implements CliStreamConverter {
  private answer: string | undefined;

  error(): string | undefined { return undefined; }
  output(): string | undefined { return this.answer; }

  convert(entry: Record<string, unknown>): ProgressUpdate[] {
    const outcome = record(entry.outcome);
    if (outcome.type === "discarded") return [];
    if (entry.type === "message" && entry.role === "assistant") {
      const content = Array.isArray(entry.content) ? entry.content : [];
      const text = content.map(record).filter((block) => block.type === "text")
        .map((block) => string(block.text)).join("\n\n");
      // Vibe's text mode returns the last non-empty assistant message.
      if (!text.trim()) return [];
      this.answer = text;
      return [{ partialOutput: text }];
    }
    if (entry.type === "reasoning") {
      const thought = string(entry.text);
      return thought ? [{ thought }] : [];
    }
    if (entry.type !== "effect" || typeof entry.id !== "string") return [];
    const detail = record(entry.detail);
    const state = record(entry.state);
    const error = record(state.error);
    const display = record(detail.display);
    const name = string(detail.toolName) || string(entry.title) || "tool";
    const tool: ToolUseEvent = {
      id: entry.id, name, kind: toolKind(string(detail.kind)),
      title: (string(display.message) || name).slice(0, TOOL_TITLE_LIMIT),
      status: "started", input: detail.input
    };
    const status = error.code === "tool_denied" ? "denied"
      : state.status === "failed" || Object.keys(error).length > 0 ? "failed" : "completed";
    const output = string(state.outputText) || string(error.message);
    return [
      { toolUse: tool },
      { toolUse: { ...tool, status, output: output.slice(0, TOOL_OUTPUT_LIMIT) || undefined } }
    ];
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}
function string(value: unknown): string { return typeof value === "string" ? value : ""; }
function toolKind(kind: string): ToolKind {
  switch (kind) {
    case "shell": return "execute";
    case "file_read": return "read";
    case "file_edit": case "file_write": return "edit";
    case "web_search": return "search";
    case "web_fetch": return "fetch";
    case "subagent": case "todo": return "think";
    case "read": case "edit": case "delete": case "move": case "search":
    case "execute": case "think": case "fetch": return kind;
    default: return "other";
  }
}
