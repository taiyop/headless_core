import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHeadlessCore,
  EffortError,
  HeadlessSessionError,
  type HeadlessCore,
  type ProgressEvent
} from "../src/index.js";

type FakeUserMessage = { type: "user"; message: { role: "user"; content: string } };

type FakeQueryRecord = {
  options: Record<string, unknown>;
  prompts: string[];
  setModelCalls: Array<string | undefined>;
  flagSettings: Array<Record<string, unknown>>;
  interrupts: number;
  closed: boolean;
};

const fake = vi.hoisted(() => ({ queries: [] as FakeQueryRecord[] }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query({ prompt, options }: { prompt: AsyncIterable<FakeUserMessage>; options: Record<string, unknown> }) {
    const record: FakeQueryRecord = {
      options,
      prompts: [],
      setModelCalls: [],
      flagSettings: [],
      interrupts: 0,
      closed: false
    };
    fake.queries.push(record);
    const sessionId = options.sessionId as string;
    let interrupted: (() => void) | undefined;

    async function* messages() {
      for await (const input of prompt) {
        const text = input.message.content;
        record.prompts.push(text);
        if (text === "hang") {
          await new Promise<void>((resolve) => {
            interrupted = resolve;
          });
          yield { type: "result", subtype: "error_during_execution", is_error: true, errors: [], session_id: sessionId };
          continue;
        }
        if (text === "fail") {
          yield {
            type: "assistant",
            parent_tool_use_id: null,
            error: "rate_limit",
            message: { content: [] },
            session_id: sessionId
          };
          yield { type: "result", subtype: "success", is_error: true, result: "429 rate limit", session_id: sessionId };
          continue;
        }
        const reply = `echo:${text}`;
        for (const chunk of [reply.slice(0, 4), reply.slice(4)]) {
          yield {
            type: "stream_event",
            parent_tool_use_id: null,
            event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: chunk } },
            session_id: sessionId
          };
        }
        yield { type: "result", subtype: "success", is_error: false, result: reply, session_id: sessionId };
      }
    }

    const iterator = messages();
    return Object.assign(iterator, {
      async interrupt() {
        record.interrupts += 1;
        interrupted?.();
        interrupted = undefined;
      },
      async setModel(model?: string) {
        record.setModelCalls.push(model);
      },
      async applyFlagSettings(settings: Record<string, unknown>) {
        record.flagSettings.push(settings);
      },
      async supportedModels() {
        return [
          {
            value: "default",
            displayName: "Default",
            description: "Recommended",
            supportsEffort: true,
            supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"]
          },
          {
            value: "haiku",
            resolvedModel: "claude-haiku-5-5",
            displayName: "Haiku",
            description: "Fast",
            supportsEffort: true,
            supportedEffortLevels: ["low", "medium", "high"]
          }
        ];
      },
      close() {
        record.closed = true;
        void iterator.return(undefined);
      }
    });
  }
}));

let headless: HeadlessCore;

beforeEach(() => {
  fake.queries.length = 0;
  headless = createHeadlessCore({ timeoutMs: 5_000 });
});

afterEach(async () => {
  await headless.shutdown();
});

describe("claude sdk sessions", () => {
  it("starts a text-only query and streams deltas", async () => {
    const session = await headless.createSession({ agent: { provider: "claude", transport: "sdk", model: "haiku" } });
    expect(session.transport).toBe("sdk");
    expect(session.id).toBe(fake.queries[0]!.options.sessionId);

    const events: ProgressEvent[] = [];
    const reply = await session.run({ prompt: "hi", onProgress: (event) => void events.push(event) });

    expect(reply).toBe("echo:hi");
    expect(events.filter((event) => event.state === "running").map((event) => event.partialOutput).join("")).toBe(
      "echo:hi"
    );
    expect(events.at(-1)?.state).toBe("completed");
    expect(fake.queries[0]!.options).toMatchObject({
      tools: [],
      permissionMode: "dontAsk",
      includePartialMessages: true,
      persistSession: false,
      model: "haiku"
    });
  });

  it("keeps one query across turns and replaces it on reset()", async () => {
    const session = await headless.createSession({ agent: { provider: "claude", transport: "sdk" } });
    await session.run({ prompt: "one" });
    await session.run({ prompt: "two" });
    expect(fake.queries).toHaveLength(1);
    expect(fake.queries[0]!.prompts).toEqual(["one", "two"]);
    expect(fake.queries[0]!.options.model).toBeUndefined();

    const firstId = session.id;
    await session.reset();
    expect(fake.queries[0]!.closed).toBe(true);
    expect(fake.queries).toHaveLength(2);
    expect(session.id).not.toBe(firstId);
    await expect(session.run({ prompt: "three" })).resolves.toBe("echo:three");
  });

  it("honors headless.run() over the sdk transport", async () => {
    const output = await headless.run({ agent: { provider: "claude", transport: "sdk" }, prompt: "once" });
    expect(output).toBe("echo:once");
    expect(fake.queries[0]!.closed).toBe(true);
  });

  it("lists models with their effort levels", async () => {
    const session = await headless.createSession({ agent: { provider: "claude", transport: "sdk" } });
    const models = await session.getAvailableModels();
    expect(models.map((model) => model.id)).toEqual(["default", "haiku"]);
    expect(models[1]).toMatchObject({ name: "Haiku", reasoningEfforts: ["low", "medium", "high"] });
  });

  it("setModel switches model and effort on the live query", async () => {
    const session = await headless.createSession({ agent: { provider: "claude", transport: "sdk" } });
    await session.setModel("haiku", "low");
    await session.setModel("default", "default");
    const record = fake.queries[0]!;
    expect(record.setModelCalls).toEqual(["haiku", undefined]);
    expect(record.flagSettings).toEqual([{ effortLevel: "low" }, { effortLevel: null }]);
  });

  it("rejects efforts the SDK or model cannot express", async () => {
    await expect(
      headless.createSession({ agent: { provider: "claude", transport: "sdk", reasoningEffort: "none" } })
    ).rejects.toBeInstanceOf(EffortError);
    expect(fake.queries).toHaveLength(0);

    const error = await headless
      .createSession({ agent: { provider: "claude", transport: "sdk", model: "haiku", reasoningEffort: "max" } })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(EffortError);
    expect((error as EffortError).code).toBe("UNSUPPORTED_EFFORT");
    expect((error as EffortError).supportedEfforts).toEqual(["low", "medium", "high"]);
    expect(fake.queries[0]!.closed).toBe(true);
  });

  it("surfaces failed results as session errors", async () => {
    const session = await headless.createSession({ agent: { provider: "claude", transport: "sdk" } });
    const error = await session.run({ prompt: "fail" }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(HeadlessSessionError);
    expect((error as Error).message).toContain("rate_limit");
    await expect(session.run({ prompt: "after" })).resolves.toBe("echo:after");
  });

  it("timeoutMs interrupts the turn and keeps the session reusable", async () => {
    const session = await headless.createSession({ agent: { provider: "claude", transport: "sdk" } });
    const error = await session.run({ prompt: "hang", timeoutMs: 50 }).catch((cause: unknown) => cause);
    expect((error as HeadlessSessionError).code).toBe("REQUEST_TIMEOUT");
    expect(fake.queries[0]!.interrupts).toBe(1);
    await expect(session.run({ prompt: "next" })).resolves.toBe("echo:next");
  });

  it("AbortSignal interrupts the turn", async () => {
    const session = await headless.createSession({ agent: { provider: "claude", transport: "sdk" } });
    const controller = new AbortController();
    const pending = session.run({ prompt: "hang", signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    const error = await pending.catch((cause: unknown) => cause);
    expect((error as HeadlessSessionError).code).toBe("REQUEST_ABORTED");
  });

  it("close() ends the query and later runs fail with SESSION_CLOSED", async () => {
    const session = await headless.createSession({ agent: { provider: "claude", transport: "sdk" } });
    await session.close();
    expect(fake.queries[0]!.closed).toBe(true);
    const error = await session.run({ prompt: "x" }).catch((cause: unknown) => cause);
    expect((error as HeadlessSessionError).code).toBe("SESSION_CLOSED");
  });

  it("shutdown() closes sdk queries", async () => {
    await headless.createSession({ agent: { provider: "claude", transport: "sdk" } });
    await headless.shutdown();
    expect(fake.queries[0]!.closed).toBe(true);
  });

  it("rejects the sdk transport for other providers", async () => {
    const error = await headless
      .createSession({ agent: { provider: "codex", transport: "sdk" } })
      .catch((cause: unknown) => cause);
    expect((error as HeadlessSessionError).code).toBe("UNSUPPORTED_TRANSPORT");
  });
});
