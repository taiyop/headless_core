import { describe, expect, it } from "vitest";
import { ClaudeStreamConverter } from "../src/claudeTools.js";
import {
  TOOL_OUTPUT_LIMIT,
  TOOL_TITLE_LIMIT,
  acpToolKind,
  agyToolKind,
  claudeToolKind,
  codexToolKind,
  grokToolKind,
  todosToPlan,
  toolTitle,
  truncateOutput,
  truncateTitle,
  type ProgressUpdate
} from "../src/progress.js";
import { expectConformance, mergedToolCalls, readFixture } from "./helpers/conformance.js";

type Converter = {
  convert(message: Record<string, unknown>): ProgressUpdate[];
  error(): string | undefined;
  output(): string | undefined;
};

function convertFixture(name: string, converter: Converter): { events: ProgressUpdate[]; output: string | undefined } {
  const events = readFixture(name).flatMap((line) => converter.convert(line));
  return { events, output: converter.output() };
}

describe("claude cli fixtures", () => {
  it("no tools: text deltas rebuild the result the text format printed", () => {
    const { events, output } = convertFixture("claude-cli/no-tools.jsonl", new ClaudeStreamConverter());
    const result = readFixture("claude-cli/no-tools.jsonl").find((line) => line.type === "result");
    expect(output).toBe(String(result?.result).trim());
    expectConformance(events, output ?? "", { exact: true });
  });

  it("tools: Bash and Read with kind and title; redacted thinking yields no thought", () => {
    const converter = new ClaudeStreamConverter();
    const { events, output } = convertFixture("claude-cli/tools.jsonl", converter);
    expect(converter.error()).toBeUndefined();
    expect(output).toContain("# Sample Project");
    expectConformance(events, output ?? "");
    // claude 2.1.312 streams thinking_delta with an empty `thinking` (display
    // "updates"): there is no thinking text to report, and no empty thoughts.
    expect(readFixture("claude-cli/tools.jsonl").some((line) => JSON.stringify(line).includes("thinking_delta"))).toBe(true);
    expect(events.some((event) => event.thought !== undefined)).toBe(false);
    const calls = mergedToolCalls(events);
    expect(calls.map((call) => [call.name, call.kind, call.status])).toEqual([
      ["Bash", "execute", "completed"],
      ["Read", "read", "completed"]
    ]);
    expect(calls[0]?.title).toMatch(/^ls/);
    expect(calls[1]?.locations?.[0]?.path).toMatch(/README\.md$/);
  });

  it("does not resend a streamed thinking block from the assistant message", () => {
    const converter = new ClaudeStreamConverter();
    const updates = [
      { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: "m" } } },
      {
        type: "stream_event",
        parent_tool_use_id: null,
        event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "a" } }
      },
      { type: "assistant", parent_tool_use_id: null, message: { id: "m", content: [{ type: "thinking", thinking: "a" }] } },
      { type: "assistant", parent_tool_use_id: null, message: { id: "n", content: [{ type: "thinking", thinking: "b" }] } }
    ].flatMap((message) => converter.convert(message));
    expect(updates).toEqual([{ thought: "a" }, { thought: "b" }]);
  });
});

describe("kind tables", () => {
  it("maps claude tool names", () => {
    expect(
      ["Bash", "BashOutput", "Read", "NotebookRead", "Edit", "Write", "NotebookEdit", "MultiEdit"].map(claudeToolKind)
    ).toEqual(["execute", "execute", "read", "read", "edit", "edit", "edit", "edit"]);
    expect(["Grep", "Glob", "WebSearch", "WebFetch", "Task", "Agent", "Skill"].map(claudeToolKind)).toEqual([
      "search",
      "search",
      "search",
      "fetch",
      "think",
      "think",
      "other"
    ]);
  });

  it("maps codex item types in both spellings", () => {
    expect(
      [
        "command_execution",
        "commandExecution",
        "file_change",
        "fileChange",
        "web_search",
        "webSearch",
        "mcp_tool_call",
        "mcpToolCall"
      ].map(codexToolKind)
    ).toEqual(["execute", "execute", "edit", "edit", "search", "search", "other", "other"]);
  });

  it("passes ACP kinds through and folds switch_mode/unknown into other", () => {
    expect(["read", "execute", "fetch", "switch_mode", "bogus", undefined].map(acpToolKind)).toEqual([
      "read",
      "execute",
      "fetch",
      "other",
      "other",
      "other"
    ]);
  });

  it("maps agy and grok tool names", () => {
    expect(["run_command", "view_file", "grep_search", "read_url_content", "write_to_file", "browser_click_element", "x"].map(agyToolKind)).toEqual([
      "execute",
      "read",
      "search",
      "fetch",
      "edit",
      "fetch",
      "other"
    ]);
    expect(["run_terminal_command", "read_file", "web_search", "web_fetch", "search_replace", "x"].map(grokToolKind)).toEqual([
      "execute",
      "read",
      "search",
      "fetch",
      "edit",
      "other"
    ]);
  });
});

describe("titles, outputs and plans", () => {
  it("picks the most meaningful input field", () => {
    expect(toolTitle({ description: "d", command: "git status" })).toBe("git status");
    expect(toolTitle({ path: "src/a.ts", url: "https://x" })).toBe("https://x");
    expect(toolTitle({ pattern: "TODO", file_path: "a.ts" })).toBe("a.ts");
    expect(toolTitle({ target_file: "README.md" })).toBe("README.md");
    expect(toolTitle({ command: ["ls", "-la"] })).toBe("ls -la");
    expect(toolTitle({ other: 1 })).toBeUndefined();
    expect(toolTitle("x")).toBeUndefined();
  });

  it("caps titles to one line of TOOL_TITLE_LIMIT characters", () => {
    expect(truncateTitle("a\n  b")).toBe("a b");
    const long = truncateTitle("x".repeat(500));
    expect(long).toHaveLength(TOOL_TITLE_LIMIT);
    expect(long.endsWith("…")).toBe(true);
  });

  it("caps outputs at TOOL_OUTPUT_LIMIT characters", () => {
    expect(truncateOutput("short")).toBe("short");
    const long = truncateOutput("y".repeat(TOOL_OUTPUT_LIMIT + 10));
    expect(long.startsWith("y".repeat(TOOL_OUTPUT_LIMIT))).toBe(true);
    expect(long.endsWith("[truncated]")).toBe(true);
  });

  it("converts TodoWrite todos into a plan snapshot", () => {
    expect(
      todosToPlan({
        todos: [
          { content: "a", status: "pending", activeForm: "A" },
          { content: "b", status: "in_progress", activeForm: "B" },
          { content: "c", status: "completed", activeForm: "C" }
        ]
      })
    ).toEqual([
      { content: "a", status: "pending" },
      { content: "b", status: "in_progress" },
      { content: "c", status: "completed" }
    ]);
    expect(todosToPlan({})).toBeUndefined();
  });
});
