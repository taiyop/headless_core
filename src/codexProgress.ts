import {
  codexToolKind,
  describeToolUse,
  isRecord,
  outputText,
  planStatus,
  truncateOutput,
  truncateTitle,
  type ProgressUpdate
} from "./progress.js";
import type { PlanEntry, ToolUseEvent, ToolUseStatus } from "./types.js";

/**
 * Item types that are tool calls, in `codex exec --json` (snake_case) and
 * app-server (camelCase) spelling. Field names follow codex-cli 0.159.x:
 * exec items are flat snake_case objects, app-server items are the v2
 * ThreadItem union (`codex app-server generate-ts`).
 */
const TOOL_ITEM_TYPES = new Set([
  "command_execution",
  "commandExecution",
  "file_change",
  "fileChange",
  "web_search",
  "webSearch",
  "mcp_tool_call",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "imageView"
]);

/**
 * Tracks codex tool items across their started/updated/completed events so
 * `started` is resent only when the title or input changed, and the terminal
 * status is reported exactly once.
 */
class CodexToolItems {
  private readonly startedKeys = new Map<string, string>();
  private readonly finished = new Set<string>();

  started(item: Record<string, unknown>, onlyIfChanged = false): ProgressUpdate[] {
    const id = String(item.id ?? "");
    if (this.finished.has(id)) {
      return [];
    }
    const event = toolEvent(item, "started");
    const key = JSON.stringify([event.title ?? null, event.input ?? null]);
    if (onlyIfChanged && this.startedKeys.get(id) === key) {
      return [];
    }
    this.startedKeys.set(id, key);
    return [toolUpdate(event)];
  }

  completed(item: Record<string, unknown>): ProgressUpdate[] {
    const id = String(item.id ?? "");
    if (this.finished.has(id)) {
      return [];
    }
    const updates = this.startedKeys.has(id) ? [] : this.started(item);
    this.finished.add(id);
    updates.push(toolUpdate(toolEvent(item, terminalStatus(item))));
    return updates;
  }
}

/**
 * Converts `codex exec --json` JSONL events. The final output is the last
 * `agent_message`, which is what plain `codex exec` prints on stdout.
 *
 * `item` events of type `error` are non-fatal warnings (config notices,
 * model metadata fallbacks); a run fails on `turn.failed`, or on a
 * top-level `error` when the turn never completed.
 */
export class CodexExecConverter {
  private readonly tools = new CodexToolItems();
  private lastMessage: string | undefined;
  private lastError: string | undefined;
  private failed: string | undefined;
  private completed = false;

  convert(message: Record<string, unknown>): ProgressUpdate[] {
    switch (message.type) {
      case "item.started":
      case "item.updated":
      case "item.completed":
        return isRecord(message.item) ? this.item(String(message.type), message.item) : [];
      case "error":
        this.lastError = errorMessage(message.message);
        return [];
      case "turn.failed":
        this.failed = errorMessage(isRecord(message.error) ? message.error.message : undefined) ?? "codex turn failed";
        return [];
      case "turn.completed":
        this.completed = true;
        return [];
      default:
        return [];
    }
  }

  error(): string | undefined {
    return this.failed ?? (this.completed ? undefined : this.lastError);
  }

  output(): string | undefined {
    return this.completed ? (this.lastMessage ?? "").trim() : undefined;
  }

  private item(type: string, item: Record<string, unknown>): ProgressUpdate[] {
    const itemType = String(item.type ?? "");
    if (TOOL_ITEM_TYPES.has(itemType)) {
      if (type === "item.completed") {
        return this.tools.completed(item);
      }
      return this.tools.started(item, type === "item.updated");
    }
    if (itemType === "todo_list") {
      const plan = todoListPlan(item.items);
      return plan ? [{ plan }] : [];
    }
    if (type !== "item.completed") {
      return [];
    }
    if (itemType === "agent_message" && typeof item.text === "string") {
      this.lastMessage = item.text;
      return item.text ? [{ partialOutput: item.text }] : [];
    }
    if (itemType === "reasoning" && typeof item.text === "string" && item.text) {
      return [{ thought: item.text }];
    }
    return [];
  }
}

/**
 * Converts codex app-server item/reasoning/plan notifications for one turn.
 * Agent message deltas and turn completion stay with the session.
 */
export class CodexAppServerProgress {
  private readonly tools = new CodexToolItems();
  /** Reasoning items that streamed deltas, and the summary part last seen. */
  private readonly reasoning = new Map<string, number>();

  convert(method: string, params: Record<string, unknown>): ProgressUpdate[] {
    switch (method) {
      case "item/started": {
        const item = isRecord(params.item) ? params.item : undefined;
        return item && TOOL_ITEM_TYPES.has(String(item.type)) ? this.tools.started(item) : [];
      }
      case "item/completed": {
        const item = isRecord(params.item) ? params.item : undefined;
        if (!item) {
          return [];
        }
        if (TOOL_ITEM_TYPES.has(String(item.type))) {
          return this.tools.completed(item);
        }
        if (item.type === "reasoning" && !this.reasoning.has(String(item.id ?? ""))) {
          // No deltas streamed for this item: report the whole reasoning once.
          const text = [stringList(item.summary), stringList(item.content)].find((parts) => parts.length)?.join("\n\n");
          return text ? [{ thought: text }] : [];
        }
        return [];
      }
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta": {
        if (typeof params.delta !== "string" || !params.delta) {
          return [];
        }
        const itemId = String(params.itemId ?? "");
        const index = typeof params.summaryIndex === "number" ? params.summaryIndex : 0;
        const previous = this.reasoning.get(itemId);
        this.reasoning.set(itemId, index);
        // A new summary part starts a new paragraph.
        const separator = previous !== undefined && index > previous ? "\n\n" : "";
        return [{ thought: `${separator}${params.delta}` }];
      }
      case "turn/plan/updated": {
        if (!Array.isArray(params.plan)) {
          return [];
        }
        return [
          {
            plan: params.plan.filter(isRecord).map((step) => ({ content: String(step.step ?? ""), status: planStatus(step.status) }))
          }
        ];
      }
      default:
        return [];
    }
  }
}

function toolUpdate(toolUse: ToolUseEvent): ProgressUpdate {
  return { toolUse, message: describeToolUse(toolUse) };
}

function toolEvent(item: Record<string, unknown>, status: ToolUseStatus): ToolUseEvent {
  const type = String(item.type ?? "");
  const kind = codexToolKind(type);
  const { title, input, locations } = describeItem(type, item);
  const output = status === "started" ? undefined : itemOutput(type, item);
  return {
    id: String(item.id ?? ""),
    name: type,
    status,
    kind,
    ...(title ? { title: truncateTitle(title) } : {}),
    ...(locations?.length ? { locations } : {}),
    ...(status === "started" && input !== undefined ? { input } : {}),
    ...(output ? { output: truncateOutput(output) } : {})
  };
}

function describeItem(
  type: string,
  item: Record<string, unknown>
): { title?: string; input?: unknown; locations?: { path: string }[] } {
  switch (type) {
    case "command_execution":
    case "commandExecution": {
      const command = typeof item.command === "string" ? item.command : "";
      return { title: unwrapShell(command), input: { command } };
    }
    case "file_change":
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes.filter(isRecord) : [];
      const locations = changes.flatMap((change) => (typeof change.path === "string" ? [{ path: change.path }] : []));
      return {
        title: locations.map((location) => location.path).join(", "),
        input: { changes: changes.map((change) => ({ path: change.path, kind: change.kind })) },
        locations
      };
    }
    case "web_search":
    case "webSearch": {
      const action = isRecord(item.action) ? item.action : {};
      const query = [item.query, action.query, action.url].find((value) => typeof value === "string" && value);
      return query ? { title: String(query), input: { query } } : {};
    }
    case "mcp_tool_call":
    case "mcpToolCall":
      return { title: `${String(item.server ?? "")}/${String(item.tool ?? "")}`, input: item.arguments };
    case "dynamicToolCall":
      return {
        title: [item.namespace, item.tool].filter((part) => typeof part === "string" && part).join("/"),
        input: item.arguments
      };
    case "collabAgentToolCall":
      return { title: String(item.tool ?? ""), input: item.prompt ?? undefined };
    case "imageView":
      return typeof item.path === "string" ? { title: item.path, locations: [{ path: item.path }] } : {};
    default:
      return {};
  }
}

function itemOutput(type: string, item: Record<string, unknown>): string | undefined {
  switch (type) {
    case "command_execution":
    case "commandExecution":
      return outputText(item.aggregated_output ?? item.aggregatedOutput);
    case "web_search":
    case "webSearch": {
      // Result titles and URLs: the references a GUI lists for a search.
      const results = Array.isArray(item.results) ? item.results.filter(isRecord) : [];
      const lines = results.flatMap((result) => {
        const parts = [result.title, result.url].filter((part) => typeof part === "string" && part);
        return parts.length ? [parts.join(" — ")] : [];
      });
      return lines.length ? lines.join("\n") : undefined;
    }
    case "mcp_tool_call":
    case "mcpToolCall": {
      const error = isRecord(item.error) ? item.error.message : undefined;
      if (typeof error === "string" && error) {
        return error;
      }
      const result = isRecord(item.result) ? item.result : undefined;
      return contentText(result?.content) || outputText(result?.structuredContent ?? result?.structured_content);
    }
    case "dynamicToolCall":
      return contentText(item.contentItems);
    default:
      return undefined;
  }
}

function terminalStatus(item: Record<string, unknown>): ToolUseStatus {
  const status = item.status;
  if (status === "declined") {
    return "denied";
  }
  if (status === "failed" || item.success === false || (isRecord(item.error) && item.error.message)) {
    return "failed";
  }
  const exitCode = item.exit_code ?? item.exitCode;
  if (typeof exitCode === "number" && exitCode !== 0) {
    return "failed";
  }
  return "completed";
}

/** `/bin/zsh -lc "ls -la"` -> `ls -la`: codex wraps every command in a login shell. */
function unwrapShell(command: string): string {
  const match = /^\/bin\/\w*sh -l?c (["'])([\s\S]*)\1$/.exec(command.trim());
  return match ? match[2]!.replace(/\\(["\\$`])/g, "$1") : command;
}

function todoListPlan(items: unknown): PlanEntry[] | undefined {
  if (!Array.isArray(items)) {
    return undefined;
  }
  return items.filter(isRecord).map((entry) => ({
    content: String(entry.text ?? ""),
    status: entry.completed === true ? "completed" : "pending"
  }));
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry !== "") : [];
}

/** codex nests API errors as a JSON string: surface the inner message. */
function errorMessage(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    const inner = isRecord(parsed) && isRecord(parsed.error) ? parsed.error.message : undefined;
    return typeof inner === "string" && inner ? inner : value;
  } catch {
    return value;
  }
}
