import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import type { ProgressUpdate } from "../../src/progress.js";
import type { ToolUseEvent } from "../../src/types.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

/** Fixture lines as parsed JSON, skipping `_comment` header lines. */
export function readFixture(name: string): Record<string, unknown>[] {
  return readFileSync(join(FIXTURES, name), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => !("_comment" in line));
}

/** Tool events grouped by id, in arrival order. */
export function toolEventsById(events: ProgressUpdate[]): Map<string, ToolUseEvent[]> {
  const byId = new Map<string, ToolUseEvent[]>();
  for (const event of events) {
    if (event.toolUse) {
      byId.set(event.toolUse.id, [...(byId.get(event.toolUse.id) ?? []), event.toolUse]);
    }
  }
  return byId;
}

/**
 * The invariants every transport must satisfy:
 * - each event carries at most one of partialOutput / thought;
 * - the streamed text ends with the final output (`exact`: equals it — some
 *   providers stream intermediate messages that the final result omits);
 * - no thought leaks into the final output;
 * - every tool call is `started` at least once, then exactly one terminal event.
 */
export function expectConformance(events: ProgressUpdate[], finalOutput: string, options: { exact?: boolean } = {}): void {
  for (const event of events) {
    expect(event.partialOutput !== undefined && event.thought !== undefined).toBe(false);
  }
  const text = events.map((event) => event.partialOutput ?? "").join("");
  if (options.exact) {
    expect(text.trim()).toBe(finalOutput.trim());
  } else {
    expect(text.trim().endsWith(finalOutput.trim())).toBe(true);
  }
  const thought = events.map((event) => event.thought ?? "").join("");
  if (thought.trim()) {
    expect(finalOutput.includes(thought.trim())).toBe(false);
  }
  for (const [id, toolEvents] of toolEventsById(events)) {
    const statuses = toolEvents.map((event) => event.status);
    const terminal = statuses.filter((status) => status !== "started");
    expect(statuses[0], `tool ${id} starts with started`).toBe("started");
    expect(terminal, `tool ${id} has one terminal event`).toHaveLength(1);
    expect(statuses.at(-1), `tool ${id} ends with its terminal event`).not.toBe("started");
  }
}

/** The last event per tool id merged the way consumers are told to merge them. */
export function mergedToolCalls(events: ProgressUpdate[]): ToolUseEvent[] {
  return [...toolEventsById(events).values()].map((toolEvents) => Object.assign({}, ...toolEvents) as ToolUseEvent);
}
