import { describe, expect, it } from "vitest";
import { AgyStreamConverter } from "../src/agyProgress.js";
import { ClaudeStreamConverter } from "../src/claudeTools.js";
import { CodexAppServerProgress, CodexExecConverter } from "../src/codexProgress.js";
import {
  TOOL_OUTPUT_LIMIT,
  TOOL_TITLE_LIMIT,
  acpToolKind,
  agyToolKind,
  claudeToolKind,
  codexToolKind,
  grokToolKind,
  grokToolResultText,
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

describe("codex fixtures", () => {
  it("exec --json: commands and web searches; config warnings are not failures", () => {
    const converter = new CodexExecConverter();
    const { events, output } = convertFixture("codex-cli/exec.jsonl", converter);
    expect(converter.error()).toBeUndefined();
    const messages = readFixture("codex-cli/exec.jsonl").flatMap((line) => {
      const item = line.item as { type?: string; text?: string } | undefined;
      return line.type === "item.completed" && item?.type === "agent_message" ? [item.text] : [];
    });
    // The final output is the last agent_message, as plain `codex exec` printed.
    expect(output).toBe(messages.at(-1)?.trim());
    expectConformance(events, output ?? "");
    const calls = mergedToolCalls(events);
    expect(calls.map((call) => [call.kind, call.status])).toEqual([
      ["search", "completed"],
      ["execute", "completed"],
      ["search", "completed"]
    ]);
    // The search query is only known on completion.
    expect(calls[0]?.title).toBe("agent client protocol");
    expect(calls[0]?.output).toContain("https://");
    // The login-shell wrapper is stripped from the title, kept in the input.
    expect(calls[1]?.title?.startsWith("pwd && rg --files")).toBe(true);
    expect(calls[1]?.output).toContain("# Sample Project");
  });

  it("exec --json: reports turn.failed with the API message", () => {
    const converter = new CodexExecConverter();
    for (const message of [
      { type: "turn.started" },
      { type: "error", message: '{"type":"error","status":400,"error":{"message":"model not supported"}}' },
      { type: "turn.failed", error: { message: '{"type":"error","status":400,"error":{"message":"model not supported"}}' } }
    ]) {
      converter.convert(message);
    }
    expect(converter.error()).toBe("model not supported");
    expect(converter.output()).toBeUndefined();
  });

  it("exec --json: reasoning, file changes, mcp calls, todo lists and failed commands", () => {
    const converter = new CodexExecConverter();
    const events = [
      { type: "item.completed", item: { id: "r", type: "reasoning", text: "**Planning**" } },
      { type: "item.started", item: { id: "t", type: "todo_list", items: [{ text: "a", completed: false }] } },
      { type: "item.started", item: { id: "c", type: "command_execution", command: "false", aggregated_output: "", exit_code: null, status: "in_progress" } },
      { type: "item.updated", item: { id: "c", type: "command_execution", command: "false", aggregated_output: "x", exit_code: null, status: "in_progress" } },
      { type: "item.completed", item: { id: "c", type: "command_execution", command: "false", aggregated_output: "boom", exit_code: 1, status: "failed" } },
      { type: "item.completed", item: { id: "f", type: "file_change", changes: [{ path: "src/a.ts", kind: "update" }], status: "completed" } },
      { type: "item.started", item: { id: "m", type: "mcp_tool_call", server: "docs", tool: "search", arguments: { q: 1 }, status: "in_progress" } },
      { type: "item.completed", item: { id: "m", type: "mcp_tool_call", server: "docs", tool: "search", arguments: { q: 1 }, result: { content: [{ type: "text", text: "hit" }] }, status: "completed" } },
      { type: "item.completed", item: { id: "t", type: "todo_list", items: [{ text: "a", completed: true }] } },
      { type: "item.completed", item: { id: "a", type: "agent_message", text: "done" } },
      { type: "turn.completed" }
    ].flatMap((message) => converter.convert(message));
    expect(converter.output()).toBe("done");
    expectConformance(events, "done", { exact: true });
    expect(events[0]).toEqual({ thought: "**Planning**" });
    expect(events.flatMap((event) => (event.plan ? [event.plan] : []))).toEqual([
      [{ content: "a", status: "pending" }],
      [{ content: "a", status: "completed" }]
    ]);
    const calls = mergedToolCalls(events);
    expect(calls.map((call) => [call.id, call.kind, call.title, call.status, call.output])).toEqual([
      ["c", "execute", "false", "failed", "boom"],
      ["f", "edit", "src/a.ts", "completed", undefined],
      ["m", "other", "docs/search", "completed", "hit"]
    ]);
    expect(calls[1]?.locations).toEqual([{ path: "src/a.ts" }]);
    // item.updated without a title/input change does not resend started.
    expect(events.filter((event) => event.toolUse?.id === "c").map((event) => event.toolUse?.status)).toEqual([
      "started",
      "failed"
    ]);
  });

  it("app-server: command items from a recorded turn", () => {
    const progress = new CodexAppServerProgress();
    const events = readFixture("codex-app-server/turn.jsonl").flatMap((line) =>
      typeof line.method === "string" && line.params ? progress.convert(line.method, line.params as Record<string, unknown>) : []
    );
    expectConformance(events, "");
    const calls = mergedToolCalls(events);
    expect(calls.map((call) => [call.kind, call.title, call.status])).toEqual([
      ["execute", "rg --files -g 'README.md' -g '*' | sed -n '1,200p'", "completed"],
      ["execute", "sed -n '1p' README.md", "completed"]
    ]);
    expect(calls[1]?.output).toBe("# Sample Project\n");
    // The recorded reasoning item carried no summary text.
    expect(events.some((event) => event.thought)).toBe(false);
  });

  it("app-server: reasoning deltas, completed reasoning without deltas, plans and declined commands", () => {
    const progress = new CodexAppServerProgress();
    const events = [
      ["item/reasoning/summaryTextDelta", { itemId: "r1", delta: "first", summaryIndex: 0 }],
      ["item/reasoning/summaryTextDelta", { itemId: "r1", delta: "second", summaryIndex: 1 }],
      ["item/completed", { item: { type: "reasoning", id: "r1", summary: ["first", "second"], content: [] } }],
      ["item/completed", { item: { type: "reasoning", id: "r2", summary: ["whole"], content: [] } }],
      ["turn/plan/updated", { plan: [{ step: "a", status: "inProgress" }, { step: "b", status: "pending" }] }],
      ["item/started", { item: { type: "commandExecution", id: "c", command: "rm x", status: "inProgress" } }],
      ["item/completed", { item: { type: "commandExecution", id: "c", command: "rm x", status: "declined", aggregatedOutput: null } }],
      ["item/started", { item: { type: "webSearch", id: "w", query: "", action: { type: "other" } } }],
      ["item/completed", { item: { type: "webSearch", id: "w", query: "acp", action: { type: "search", query: "acp" }, results: null } }]
    ].flatMap(([method, params]) => progress.convert(method as string, params as Record<string, unknown>));
    expect(events.flatMap((event) => (event.thought ? [event.thought] : []))).toEqual(["first", "\n\nsecond", "whole"]);
    expect(events.find((event) => event.plan)?.plan).toEqual([
      { content: "a", status: "in_progress" },
      { content: "b", status: "pending" }
    ]);
    expectConformance(events, "");
    const calls = mergedToolCalls(events);
    expect(calls.map((call) => [call.kind, call.title, call.status])).toEqual([
      ["execute", "rm x", "denied"],
      ["search", "acp", "completed"]
    ]);
  });
});

describe("agy cli fixture", () => {
  it("stream-json: text deltas, run_command and read_file steps, no thoughts", () => {
    const converter = new AgyStreamConverter();
    const { events, output } = convertFixture("agy-cli/stream.jsonl", converter);
    expect(converter.error()).toBeUndefined();
    expectConformance(events, output ?? "", { exact: true });
    expect(output).toContain("# Sample Project");
    const calls = mergedToolCalls(events);
    expect(calls.map((call) => [call.name, call.kind, call.title, call.status])).toEqual([
      ["run_command", "execute", "ls -la", "completed"],
      ["read_file", "read", "/workspace/README.md", "completed"]
    ]);
    expect(calls[0]?.output).toContain("notes.txt");
    expect(calls[1]?.locations).toEqual([{ path: "/workspace/README.md" }]);
    expect(events.some((event) => event.thought)).toBe(false);
  });

  it("reports a non-SUCCESS result as the run error", () => {
    const converter = new AgyStreamConverter();
    converter.convert({ event: "result", result: { status: "ERROR", error: "quota exceeded" } });
    expect(converter.error()).toBe("quota exceeded");
    expect(new AgyStreamConverter().output()).toBeUndefined();
  });
});

describe("grok cli fixture", () => {
  const grokConverter = () => new ClaudeStreamConverter("grok", { kindOf: grokToolKind, resultText: grokToolResultText });

  it("streaming-messages-json: text and thinking deltas, decoded tool results", () => {
    const converter = grokConverter();
    const { events, output } = convertFixture("grok-cli/stream.jsonl", converter);
    expect(converter.error()).toBeUndefined();
    expect(output).toContain("# Sample Project");
    expectConformance(events, output ?? "");
    expect(events.filter((event) => event.thought).length).toBeGreaterThan(0);
    const calls = mergedToolCalls(events);
    expect(calls.map((call) => [call.name, call.kind, call.title, call.status])).toEqual([
      ["run_terminal_command", "execute", "ls -la", "completed"],
      ["read_file", "read", "README.md", "completed"]
    ]);
    // The byte-array Bash output is decoded to text.
    expect(calls[0]?.output).toContain("notes.txt");
    expect(calls[1]?.output).toContain("# Sample Project");
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
