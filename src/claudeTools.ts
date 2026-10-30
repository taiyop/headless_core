import { ToolsError } from "./errors.js";
import {
  claudeToolKind,
  describeToolUse,
  isRecord,
  todosToPlan,
  toolTitle,
  truncateOutput,
  type ProgressUpdate
} from "./progress.js";
import {
  TOOL_PERMISSION_MODES,
  type AgentSpec,
  type ToolKind,
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

/** Options for Claude-shaped streams emitted by other CLIs (grok streaming-messages-json). */
export type ClaudeStreamOptions = {
  /** Tool name -> kind. Defaults to the Claude Code tool table. */
  kindOf?: (name: string) => ToolKind;
  /** tool_result content -> text. Defaults to the text blocks of the content. */
  resultText?: (content: unknown) => string;
};

/**
 * Extracts ToolUseEvents from Claude Code stream-json / Agent SDK messages
 * (the two share one message shape).
 *
 * A denied call is reported once as `denied`: the error tool_result Claude
 * Code sends back for it afterwards is swallowed.
 */
export class ClaudeToolUseTracker {
  private readonly denied = new Set<string>();
  private readonly calls = new Map<string, Pick<ToolUseEvent, "name" | "kind" | "title" | "locations">>();
  private readonly kindOf: (name: string) => ToolKind;
  private readonly resultText: (content: unknown) => string;

  constructor(options: ClaudeStreamOptions = {}) {
    this.kindOf = options.kindOf ?? claudeToolKind;
    this.resultText = options.resultText ?? toolResultText;
  }

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
          ...(this.calls.get(id) ?? this.describe(String(message.tool_name ?? ""), undefined)),
          id,
          ...(typeof message.tool_name === "string" ? { name: message.tool_name } : {}),
          status: "denied",
          ...(typeof message.message === "string" ? { output: truncateOutput(message.message) } : {})
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
        const call = this.describe(String(block.name ?? ""), block.input);
        this.calls.set(id, call);
        events.push(withParent({ id, ...call, status: "started", input: block.input }));
      } else if (message.type === "user" && block.type === "tool_result") {
        const id = String(block.tool_use_id ?? "");
        if (this.denied.delete(id)) {
          continue;
        }
        events.push(
          withParent({
            id,
            ...(this.calls.get(id) ?? { name: "" }),
            status: block.is_error === true ? "failed" : "completed",
            output: truncateOutput(this.resultText(block.content))
          })
        );
      }
    }
    return events;
  }

  private describe(name: string, input: unknown): Pick<ToolUseEvent, "name" | "kind" | "title" | "locations"> {
    const title = toolTitle(input);
    const path = isRecord(input) ? (input.file_path ?? input.notebook_path) : undefined;
    return {
      name,
      kind: this.kindOf(name),
      ...(title ? { title } : {}),
      ...(typeof path === "string" && path ? { locations: [{ path }] } : {})
    };
  }
}

/**
 * Converts Claude Code stream-json / Agent SDK messages into ProgressUpdates:
 * top-level text deltas as `partialOutput`, thinking deltas as `thought`,
 * tool calls as `toolUse` and TodoWrite todo lists as `plan`. Also remembers
 * the `result` message, which carries the final output.
 *
 * Without partial messages only whole `assistant` thinking blocks arrive;
 * those are reported unless their message already streamed thinking deltas.
 */
export class ClaudeStreamConverter {
  private readonly tools: ClaudeToolUseTracker;
  private readonly streamedThinking = new Set<string>();
  private streamMessageId = "";
  private result: Record<string, unknown> | undefined;
  private assistantError: string | undefined;
  private text = "";

  constructor(
    private readonly provider = "claude",
    options: ClaudeStreamOptions = {}
  ) {
    this.tools = new ClaudeToolUseTracker(options);
  }

  convert(message: unknown): ProgressUpdate[] {
    if (!isRecord(message)) {
      return [];
    }
    const topLevel = message.parent_tool_use_id == null;
    if (message.type === "stream_event") {
      const event = isRecord(message.event) ? message.event : {};
      if (!topLevel) {
        return [];
      }
      if (event.type === "message_start") {
        this.streamMessageId = isRecord(event.message) ? String(event.message.id ?? "") : "";
        return [];
      }
      const delta = isRecord(event.delta) ? event.delta : {};
      if (event.type !== "content_block_delta") {
        return [];
      }
      if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
        this.text += delta.text;
        return [{ partialOutput: delta.text }];
      }
      if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking) {
        this.streamedThinking.add(this.streamMessageId);
        return [{ thought: delta.thinking }];
      }
      return [];
    }
    if (message.type === "result") {
      this.result = message;
      return [];
    }

    const updates: ProgressUpdate[] = [];
    if (message.type === "assistant" && topLevel && isRecord(message.message)) {
      if (typeof message.error === "string") {
        this.assistantError = message.error;
      }
      const id = String(message.message.id ?? "");
      const content = Array.isArray(message.message.content) ? message.message.content : [];
      if (!this.streamedThinking.has(id)) {
        for (const block of content) {
          if (isRecord(block) && block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
            updates.push({ thought: block.thinking });
          }
        }
      }
    }
    for (const toolUse of this.tools.events(message)) {
      updates.push({ toolUse, message: describeToolUse(toolUse) });
      if (toolUse.status === "started" && /^todo_?write$/i.test(toolUse.name)) {
        const plan = todosToPlan(toolUse.input);
        if (plan) {
          updates.push({ plan });
        }
      }
    }
    return updates;
  }

  /** The `result` message's failure, prefixed with the assistant error when one was reported. */
  error(): string | undefined {
    const result = this.result;
    if (!result || (result.subtype === "success" && result.is_error !== true)) {
      return undefined;
    }
    const errors = Array.isArray(result.errors) ? result.errors.join("\n") : "";
    const details = (typeof result.result === "string" && result.result) || errors || String(result.subtype);
    return `${this.assistantError ? `${this.assistantError}: ` : ""}${details || `${this.provider} run failed`}`;
  }

  /** The final output once the `result` message arrived; streamed text when it carries none. */
  output(): string | undefined {
    if (!this.result) {
      return undefined;
    }
    return (typeof this.result.result === "string" && this.result.result ? this.result.result : this.text).trim();
  }
}

export { describeToolUse };

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
