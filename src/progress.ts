import type { PlanEntry, PlanEntryStatus, ProgressEvent, ToolKind, ToolUseEvent, ToolUseLocation } from "./types.js";

/** Maximum length of ToolUseEvent.title. */
export const TOOL_TITLE_LIMIT = 200;
/** Maximum length of ToolUseEvent.output. */
export const TOOL_OUTPUT_LIMIT = 8192;

/**
 * The provider-neutral payload of a `running` ProgressEvent. Transport event
 * converters return these; the transport adds `state` and `agent`.
 */
export type ProgressUpdate = Pick<ProgressEvent, "message" | "partialOutput" | "thought" | "toolUse" | "plan">;

const CLAUDE_TOOL_KINDS: Record<string, ToolKind> = {
  Bash: "execute",
  BashOutput: "execute",
  Read: "read",
  NotebookRead: "read",
  Edit: "edit",
  Write: "edit",
  NotebookEdit: "edit",
  MultiEdit: "edit",
  Grep: "search",
  Glob: "search",
  WebSearch: "search",
  WebFetch: "fetch",
  Task: "think",
  Agent: "think",
  TodoWrite: "think"
};

const CODEX_TOOL_KINDS: Record<string, ToolKind> = {
  command_execution: "execute",
  commandExecution: "execute",
  file_change: "edit",
  fileChange: "edit",
  web_search: "search",
  webSearch: "search",
  mcp_tool_call: "other",
  mcpToolCall: "other",
  dynamicToolCall: "other",
  collabAgentToolCall: "think",
  imageView: "read"
};

/** Tool names from `agy --output-format stream-json` step updates (agy 1.4.x). */
const AGY_TOOL_KINDS: Record<string, ToolKind> = {
  run_command: "execute",
  command_status: "execute",
  send_command_input: "execute",
  view_file: "read",
  read_file: "read",
  read_resource: "read",
  list_dir: "search",
  find_by_name: "search",
  grep_search: "search",
  search_web: "search",
  read_url_content: "fetch",
  read_browser_page: "fetch",
  open_browser_url: "fetch",
  write_to_file: "edit",
  replace_file_content: "edit",
  multi_replace_file_content: "edit",
  sed_file: "edit",
  notebook_edit: "edit",
  invoke_subagent: "think",
  browser_subagent: "think"
};

/**
 * Tool names from `grok --output-format streaming-messages-json` (grok 1.0.x).
 * The kinds follow what grok itself reports on the ACP-shaped
 * `streaming-json` output for the same tools.
 */
const GROK_TOOL_KINDS: Record<string, ToolKind> = {
  run_terminal_command: "execute",
  get_command_or_subagent_output: "execute",
  read_file: "read",
  list_dir: "search",
  grep: "search",
  search_tool: "search",
  web_search: "search",
  web_fetch: "fetch",
  search_replace: "edit",
  write_file: "edit",
  edit_file: "edit",
  spawn_subagent: "think",
  todo_write: "think"
};

const ACP_TOOL_KINDS: readonly string[] = ["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "other"];

export function claudeToolKind(name: string): ToolKind {
  return CLAUDE_TOOL_KINDS[name] ?? "other";
}

export function codexToolKind(type: string): ToolKind {
  return CODEX_TOOL_KINDS[type] ?? "other";
}

export function agyToolKind(name: string): ToolKind {
  return AGY_TOOL_KINDS[name] ?? (name.startsWith("browser_") ? "fetch" : "other");
}

export function grokToolKind(name: string): ToolKind {
  return GROK_TOOL_KINDS[name] ?? "other";
}

/** ACP reports a ToolKind already; `switch_mode` and unknown values become `other`. */
export function acpToolKind(kind: unknown): ToolKind {
  return typeof kind === "string" && ACP_TOOL_KINDS.includes(kind) ? (kind as ToolKind) : "other";
}

/**
 * Input fields that best describe a call, most meaningful first. After the
 * common names come provider spellings of the same fields (grok
 * `target_file`, agy `CommandLine`/`Path`/`AbsolutePath`, ...).
 */
const TITLE_FIELDS = [
  "command",
  "url",
  "query",
  "file_path",
  "path",
  "pattern",
  "description",
  "CommandLine",
  "Url",
  "Query",
  "target_file",
  "absolute_path",
  "AbsolutePath",
  "Path",
  "directory_path",
  "DirectoryPath",
  "SearchPath",
  "TargetFile"
] as const;

/** A one-line title from the most meaningful string field of a tool input. */
export function toolTitle(input: unknown): string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  for (const field of TITLE_FIELDS) {
    const value = input[field];
    if (Array.isArray(value) && value.every((entry) => typeof entry === "string") && value.length) {
      return truncateTitle(value.join(" "));
    }
    if (typeof value === "string" && value.trim()) {
      return truncateTitle(value);
    }
  }
  return undefined;
}

/** Collapses a title to one line and caps it at TOOL_TITLE_LIMIT characters. */
export function truncateTitle(title: string): string {
  const line = title.replace(/\s*\r?\n\s*/g, " ").trim();
  return line.length > TOOL_TITLE_LIMIT ? `${line.slice(0, TOOL_TITLE_LIMIT - 1)}…` : line;
}

/** Caps tool output at TOOL_OUTPUT_LIMIT characters. */
export function truncateOutput(output: string): string {
  return output.length > TOOL_OUTPUT_LIMIT ? `${output.slice(0, TOOL_OUTPUT_LIMIT)}\n…[truncated]` : output;
}

/** Tool output as text: strings as-is, anything else as JSON. */
export function outputText(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function toLocations(value: unknown): ToolUseLocation[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const locations: ToolUseLocation[] = [];
  for (const entry of value) {
    if (isRecord(entry) && typeof entry.path === "string" && entry.path) {
      locations.push(typeof entry.line === "number" ? { path: entry.path, line: entry.line } : { path: entry.path });
    }
  }
  return locations.length ? locations : undefined;
}

/**
 * Claude TodoWrite `input.todos` (`{content, status, activeForm}`) as a plan
 * snapshot, or undefined when the input carries no todo list.
 */
export function todosToPlan(input: unknown): PlanEntry[] | undefined {
  const todos = isRecord(input) ? input.todos : undefined;
  if (!Array.isArray(todos)) {
    return undefined;
  }
  return todos.filter(isRecord).map((todo) => ({
    content: String(todo.content ?? todo.activeForm ?? ""),
    status: planStatus(todo.status)
  }));
}

/** Normalizes provider plan statuses (`in_progress`, `inProgress`, ...). */
export function planStatus(value: unknown): PlanEntryStatus {
  if (value === "completed" || value === "done") {
    return "completed";
  }
  if (value === "in_progress" || value === "inProgress" || value === "active") {
    return "in_progress";
  }
  return "pending";
}

/** Short human-readable summary used as ProgressEvent.message. */
export function describeToolUse(event: ToolUseEvent): string {
  return `${event.title || event.name || "tool"} ${event.status}`;
}

/**
 * Writes one raw transport event to stderr as a single JSON line when
 * HEADLESS_CORE_DEBUG_EVENTS=1. A no-op otherwise.
 */
export function debugEvent(env: NodeJS.ProcessEnv, source: string, event: unknown): void {
  if (env.HEADLESS_CORE_DEBUG_EVENTS !== "1") {
    return;
  }
  try {
    process.stderr.write(`${JSON.stringify({ headlessCoreEvent: source, event })}\n`);
  } catch {
    // Debug output must never break a run.
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
