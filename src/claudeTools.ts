import { ToolsError } from "./errors.js";
import {
  TOOL_PERMISSION_MODES,
  type AgentSpec,
  type ToolPermissionMode,
  type ToolsSpec,
  type ToolUseEvent
} from "./types.js";

/** A validated tools spec with tools actually enabled. */
export type ResolvedTools = {
  allow: string[];
  permissionMode: ToolPermissionMode;
  allowedRules: string[];
};

/**
 * Validates `agent.tools` and returns the enabled configuration, or
 * undefined when tools stay disabled (omitted, or an empty `allow`).
 * Throws ToolsError for malformed specs and for providers other than claude.
 */
export function resolveTools(agent: AgentSpec): ResolvedTools | undefined {
  const tools = agent.tools as ToolsSpec | undefined | null;
  if (tools === undefined || tools === null) {
    return undefined;
  }
  if (agent.provider !== "claude") {
    throw new ToolsError(
      "UNSUPPORTED_TOOLS",
      `Provider "${agent.provider}" does not support agent.tools (supported: claude)`
    );
  }
  if (typeof tools !== "object" || !isStringList(tools.allow)) {
    throw new ToolsError("INVALID_TOOLS", "agent.tools.allow must be an array of non-empty tool names");
  }
  const permissionMode = tools.permissionMode ?? "dontAsk";
  if (!(TOOL_PERMISSION_MODES as readonly string[]).includes(permissionMode)) {
    throw new ToolsError(
      "INVALID_TOOLS",
      `Invalid agent.tools.permissionMode "${String(permissionMode)}" (supported: ${TOOL_PERMISSION_MODES.join(", ")})`
    );
  }
  const allowedRules = tools.allowedRules ?? [];
  if (!isStringList(allowedRules)) {
    throw new ToolsError("INVALID_TOOLS", "agent.tools.allowedRules must be an array of non-empty rules");
  }
  if (tools.allow.length === 0) {
    return undefined;
  }
  return { allow: [...tools.allow], permissionMode, allowedRules: [...allowedRules] };
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim() !== "");
}

/**
 * Extracts ToolUseEvents from Claude Code stream-json / Agent SDK messages
 * (the two share one message shape).
 *
 * A denied call is reported once as `denied`: the error tool_result Claude
 * Code sends back for it afterwards is swallowed.
 */
export class ClaudeToolUseTracker {
  private readonly denied = new Set<string>();
  private readonly names = new Map<string, string>();

  events(message: unknown): ToolUseEvent[] {
    if (!isRecord(message)) {
      return [];
    }
    const parentToolUseId = typeof message.parent_tool_use_id === "string" ? message.parent_tool_use_id : undefined;
    const withParent = (event: ToolUseEvent): ToolUseEvent =>
      parentToolUseId ? { ...event, parentToolUseId } : event;

    if (message.type === "system" && message.subtype === "permission_denied") {
      const id = String(message.tool_use_id ?? "");
      this.denied.add(id);
      return [
        {
          id,
          name: String(message.tool_name ?? this.names.get(id) ?? ""),
          status: "denied",
          ...(typeof message.message === "string" ? { output: message.message } : {})
        }
      ];
    }

    if (message.type !== "assistant" && message.type !== "user") {
      return [];
    }
    const content = isRecord(message.message) ? message.message.content : undefined;
    if (!Array.isArray(content)) {
      return [];
    }
    const events: ToolUseEvent[] = [];
    for (const block of content) {
      if (!isRecord(block)) {
        continue;
      }
      if (message.type === "assistant" && block.type === "tool_use") {
        const id = String(block.id ?? "");
        const name = String(block.name ?? "");
        this.names.set(id, name);
        events.push(withParent({ id, name, status: "started", input: block.input }));
      } else if (message.type === "user" && block.type === "tool_result") {
        const id = String(block.tool_use_id ?? "");
        if (this.denied.delete(id)) {
          continue;
        }
        events.push(
          withParent({
            id,
            name: this.names.get(id) ?? "",
            status: block.is_error === true ? "failed" : "completed",
            output: toolResultText(block.content)
          })
        );
      }
    }
    return events;
  }
}

/** Short human-readable summary used as ProgressEvent.message. */
export function describeToolUse(event: ToolUseEvent): string {
  return `${event.name || "tool"} ${event.status}`;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
