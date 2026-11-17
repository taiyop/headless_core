import { describe, expect, it } from "vitest";
import { AcpProgressConverter } from "../src/acpProgress.js";
import type { ProgressUpdate } from "../src/progress.js";
import { expectConformance, mergedToolCalls, readFixture } from "./helpers/conformance.js";

function convertFixture(name: string): { events: ProgressUpdate[]; output: string } {
  const converter = new AcpProgressConverter();
  const events: ProgressUpdate[] = [];
  for (const line of readFixture(name)) {
    const params = line.params as { update?: unknown } | undefined;
    if (line.method === "session/update" && params?.update) {
      events.push(...converter.convert(params.update));
    }
  }
  // ACP sessions return the concatenated agent_message_chunk text.
  return { events, output: events.map((event) => event.partialOutput ?? "").join("") };
}

describe("ACP fixtures", () => {
  it("agy acp: tool calls, a denied-by-recorder failure, no thoughts", () => {
    const { events, output } = convertFixture("agy-acp/turn.jsonl");
    expectConformance(events, output, { exact: true });
    expect(output).toContain("# Sample Project");
    const calls = mergedToolCalls(events);
    expect(calls.map((call) => [call.kind, call.title, call.status])).toEqual([
      ["execute", "ls -la", "failed"],
      ["search", "Running list_directory", "completed"],
      ["read", "Running view_file", "completed"]
    ]);
    expect(calls[0]?.output).toBe("Rejected by user");
    expect(calls[2]?.locations).toEqual([{ path: "/workspace/README.md" }]);
    expect(events.some((event) => event.thought)).toBe(false);
  });

  it("devin acp: thoughts, plans and merged tool output", () => {
    const { events, output } = convertFixture("devin-acp/turn.jsonl");
    expectConformance(events, output, { exact: true });
    expect(events.filter((event) => event.thought).length).toBeGreaterThan(10);
    const plans = events.flatMap((event) => (event.plan ? [event.plan] : []));
    expect(plans[0]).toEqual([
      { content: "List files in the current directory", priority: "medium", status: "in_progress" },
      { content: "Read README.md and report its first line", priority: "medium", status: "pending" }
    ]);
    expect(plans.at(-1)?.every((entry) => entry.status === "completed")).toBe(true);
    const [ls, read] = mergedToolCalls(events);
    expect(ls).toMatchObject({ kind: "execute", title: "Listed ./", status: "completed", input: { command: "ls -la" } });
    // The output arrived on in_progress updates; the completed update had none.
    expect(ls?.output).toContain("README.md");
    expect(read).toMatchObject({ kind: "read", title: "Read file", status: "completed", output: "3 lines" });
  });

  it("grok acp (hand-built): thought, plan, tools", () => {
    const { events, output } = convertFixture("grok-acp/turn.jsonl");
    expectConformance(events, output, { exact: true });
    expect(events[0]).toEqual({ thought: "I should list the directory, then read README.md." });
    expect(events[1]?.plan).toHaveLength(2);
    const calls = mergedToolCalls(events);
    expect(calls.map((call) => [call.kind, call.title, call.status])).toEqual([
      ["execute", "run_terminal_command", "completed"],
      ["read", "read_file", "completed"]
    ]);
    expect(calls[1]?.locations).toEqual([{ path: "README.md" }]);
  });
});

describe("AcpProgressConverter", () => {
  it("keeps thoughts out of partialOutput", () => {
    const converter = new AcpProgressConverter();
    expect(converter.convert({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } })).toEqual([
      { thought: "hmm" }
    ]);
    expect(converter.convert({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } })).toEqual([
      { partialOutput: "hi" }
    ]);
  });

  it("survives an update that arrives before its tool_call", () => {
    const converter = new AcpProgressConverter();
    const early = converter.convert({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" });
    expect(early.map((event) => event.toolUse)).toEqual([{ id: "t1", name: "tool", status: "started" }]);
    const call = converter.convert({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "git status",
      kind: "execute",
      rawInput: { command: "git status" }
    });
    // The title/input became known: started again with the same id.
    expect(call.map((event) => event.toolUse)).toEqual([
      {
        id: "t1",
        name: "git status",
        status: "started",
        kind: "execute",
        title: "git status",
        input: { command: "git status" }
      }
    ]);
    const done = converter.convert({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      title: null,
      rawOutput: { exitCode: 0 }
    });
    expect(done.map((event) => event.toolUse)).toEqual([
      { id: "t1", name: "git status", status: "completed", kind: "execute", title: "git status", output: '{"exitCode":0}' }
    ]);
    // A terminal call is reported once.
    expect(converter.convert({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "failed" })).toEqual([]);
  });

  it("emits started before a terminal update for an unseen call", () => {
    const converter = new AcpProgressConverter();
    const events = converter.convert({ sessionUpdate: "tool_call_update", toolCallId: "t2", status: "failed", rawOutput: "boom" });
    expect(events.map((event) => event.toolUse?.status)).toEqual(["started", "failed"]);
    expect(events[1]?.toolUse?.output).toBe("boom");
  });

  it("does not resend started when nothing changed", () => {
    const converter = new AcpProgressConverter();
    converter.convert({ sessionUpdate: "tool_call", toolCallId: "t3", title: "Read", kind: "read", rawInput: { path: "a" } });
    expect(converter.convert({ sessionUpdate: "tool_call_update", toolCallId: "t3", status: "in_progress" })).toEqual([]);
  });

  it("maps switch_mode and unknown kinds to other and forgets calls on reset", () => {
    const converter = new AcpProgressConverter();
    const [started] = converter.convert({ sessionUpdate: "tool_call", toolCallId: "t4", title: "Plan mode", kind: "switch_mode" });
    expect(started?.toolUse?.kind).toBe("other");
    converter.convert({ sessionUpdate: "tool_call_update", toolCallId: "t4", status: "completed" });
    converter.reset();
    expect(converter.convert({ sessionUpdate: "tool_call_update", toolCallId: "t4", status: "completed" })).toHaveLength(2);
  });

  it("ignores other session updates", () => {
    const converter = new AcpProgressConverter();
    expect(converter.convert({ sessionUpdate: "available_commands_update", availableCommands: [] })).toEqual([]);
    expect(converter.convert({ sessionUpdate: "current_mode_update", currentModeId: "code" })).toEqual([]);
  });
});
