import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createHeadlessCore,
  EffortError,
  HeadlessSessionError,
  type HeadlessCore,
  type HeadlessSession,
  type ProgressEvent
} from "../src/index.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

let tmpDir: string;
let logPath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "headless-core-session-test-"));
  logPath = path.join(tmpDir, "fake.log");
});

afterEach(async () => {
  await rm(tmpDir, { force: true, recursive: true });
});

type LogEntry = {
  pid: number;
  method: string;
  id?: number | string;
  params?: Record<string, unknown>;
  result?: unknown;
  argv?: string[];
};

async function readLog(): Promise<LogEntry[]> {
  try {
    const text = await readFile(logPath, "utf8");
    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LogEntry);
  } catch {
    return [];
  }
}

async function waitForLog(predicate: (entries: LogEntry[]) => boolean, timeoutMs = 5_000): Promise<LogEntry[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const entries = await readLog();
    if (predicate(entries)) {
      return entries;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for log; got ${JSON.stringify(entries)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function installFixture(name: string): Promise<string> {
  const source = await readFile(path.join(FIXTURES, name), "utf8");
  const filePath = path.join(tmpDir, name);
  await writeFile(filePath, source);
  await chmod(filePath, 0o755);
  return filePath;
}

function deltasOf(events: ProgressEvent[]): string {
  return events
    .filter((event) => event.state === "running")
    .map((event) => event.partialOutput ?? "")
    .join("");
}

async function expectErrorCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (cause) {
    expect(cause).toBeInstanceOf(HeadlessSessionError);
    expect((cause as HeadlessSessionError).code).toBe(code);
    return;
  }
  throw new Error(`expected rejection with code ${code}`);
}

async function expectEffortError(promise: Promise<unknown>, code: "INVALID_EFFORT" | "UNSUPPORTED_EFFORT"): Promise<EffortError> {
  try {
    await promise;
  } catch (cause) {
    expect(cause).toBeInstanceOf(EffortError);
    expect((cause as EffortError).code).toBe(code);
    return cause as EffortError;
  }
  throw new Error(`expected rejection with code ${code}`);
}

describe("codex app-server sessions", () => {
  async function setup(): Promise<{ headless: HeadlessCore }> {
    const bin = await installFixture("fake-codex-app-server.mjs");
    const headless = createHeadlessCore({
      env: { ...process.env, CODEX_BIN: bin, FAKE_LOG: logPath }
    });
    return { headless };
  }

  it("initializes once, starts a thread, and streams deltas", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "codex", transport: "app-server" }
    });
    expect(session.id).toBe("thread-1");

    const events: ProgressEvent[] = [];
    const output = await session.run({
      prompt: "hello",
      onProgress: (event) => {
        events.push(event);
      }
    });

    expect(output).toBe("echo:hello");
    expect(deltasOf(events)).toBe("echo:hello");
    expect(events.at(0)?.state).toBe("starting");
    expect(events.at(-1)?.state).toBe("completed");

    const log = await readLog();
    expect(log.filter((entry) => entry.method === "initialize")).toHaveLength(1);
    expect(log.filter((entry) => entry.method === "thread/start")).toHaveLength(1);
    const turnStart = log.find((entry) => entry.method === "turn/start");
    expect(turnStart?.params?.threadId).toBe("thread-1");

    await session.close();
    await headless.shutdown();
  });

  it("honors headless.run() over a persistent transport", async () => {
    const { headless } = await setup();
    const output = await headless.run({
      agent: { provider: "codex", transport: "app-server" },
      prompt: "oneshot"
    });
    expect(output).toBe("echo:oneshot");
    await headless.shutdown();
  });

  it("reset() swaps in a fresh thread on the same process", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "codex", transport: "app-server" }
    });
    expect(await session.run({ prompt: "first" })).toBe("echo:first");
    const firstThread = session.id;

    await session.reset();
    expect(session.id).not.toBe(firstThread);
    expect(session.id).toBe("thread-2");
    expect(await session.run({ prompt: "second" })).toBe("echo:second");

    const log = await readLog();
    expect(
      log.some(
        (entry) => entry.method === "thread/unsubscribe" && entry.params?.threadId === firstThread
      )
    ).toBe(true);
    // Same process the whole time.
    expect(new Set(log.map((entry) => entry.pid)).size).toBe(1);

    await headless.shutdown();
  });

  it("lists models via model/list", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "codex", transport: "app-server" }
    });
    const models = await session.getAvailableModels();
    expect(models.map((model) => model.id)).toEqual(["fake-m1", "fake-m2", "fake-m3"]);
    expect(models[0]?.reasoningEfforts).toEqual(["low", "high"]);
    await headless.shutdown();
  });

  it("setModel applies model and effort to subsequent turns", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "codex", transport: "app-server" }
    });
    await session.run({ prompt: "before" });
    await session.setModel("fake-m2", "medium");
    await session.run({ prompt: "after" });

    const turnStarts = (await readLog()).filter((entry) => entry.method === "turn/start");
    expect(turnStarts).toHaveLength(2);
    expect(turnStarts[0]?.params?.model).toBeUndefined();
    expect(turnStarts[1]?.params?.model).toBe("fake-m2");
    expect(turnStarts[1]?.params?.effort).toBe("medium");
    await headless.shutdown();
  });

  it("passes none through turn/start on a codex model that supports it", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "codex", transport: "app-server" }
    });
    await session.setModel("fake-m3", "none");
    expect(await session.run({ prompt: "off" })).toBe("echo:off");

    const turnStart = (await readLog()).filter((entry) => entry.method === "turn/start").at(-1);
    expect(turnStart?.params?.model).toBe("fake-m3");
    expect(turnStart?.params?.effort).toBe("none");
    await headless.shutdown();
  });

  it("rejects none on a codex model that does not support it", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "codex", transport: "app-server" }
    });
    const error = await expectEffortError(session.setModel("fake-m1", "none"), "UNSUPPORTED_EFFORT");
    expect(error.supportedEfforts).toEqual(["low", "high"]);
    // The rejected effort is never sent on the wire.
    expect(await session.run({ prompt: "ok" })).toBe("echo:ok");
    const turnStart = (await readLog()).filter((entry) => entry.method === "turn/start").at(-1);
    expect(turnStart?.params?.effort).toBeUndefined();
    await headless.shutdown();
  });

  it("omits effort from turn/start when default is selected", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "codex", transport: "app-server", model: "fake-m1", reasoningEffort: "default" }
    });
    expect(await session.run({ prompt: "hi" })).toBe("echo:hi");
    const turnStart = (await readLog()).filter((entry) => entry.method === "turn/start").at(-1);
    expect(turnStart?.params).not.toHaveProperty("effort");
    await headless.shutdown();
  });

  it("rejects an invalid effort string before the thread starts", async () => {
    const { headless } = await setup();
    const error = await expectEffortError(
      headless.createSession({
        agent: { provider: "codex", transport: "app-server", reasoningEffort: "banana" }
      }),
      "INVALID_EFFORT"
    );
    expect(error.supportedEfforts).toContain("minimal");
    // The failed session released its runtime lease; a new session still works.
    const session = await headless.createSession({
      agent: { provider: "codex", transport: "app-server" }
    });
    expect(await session.run({ prompt: "ok" })).toBe("echo:ok");
    await headless.shutdown();
  });

  it("AbortSignal rejects the run and interrupts the turn", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "codex", transport: "app-server" }
    });
    const controller = new AbortController();
    const pending = session.run({ prompt: "NEVER", signal: controller.signal });
    await waitForLog((log) => log.some((entry) => entry.method === "turn/start"));
    controller.abort();

    await expectErrorCode(pending, "REQUEST_ABORTED");
    await waitForLog((log) => log.some((entry) => entry.method === "turn/interrupt"));
    // The session recovers once the interrupt is observed.
    expect(await session.run({ prompt: "ok" })).toBe("echo:ok");
    await headless.shutdown();
  });

  it("timeoutMs rejects the run and interrupts the turn", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "codex", transport: "app-server" }
    });
    await expectErrorCode(session.run({ prompt: "SLOW", timeoutMs: 200 }), "REQUEST_TIMEOUT");
    await waitForLog((log) => log.some((entry) => entry.method === "turn/interrupt"));
    expect(await session.run({ prompt: "ok" })).toBe("echo:ok");
    await headless.shutdown();
  });

  it("serializes concurrent runs on one session", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "codex", transport: "app-server" }
    });
    const [a, b] = await Promise.all([session.run({ prompt: "a" }), session.run({ prompt: "b" })]);
    expect(a).toBe("echo:a");
    expect(b).toBe("echo:b");
    const prompts = (await readLog())
      .filter((entry) => entry.method === "turn/start")
      .map((entry) => (entry.params?.input as Array<{ text: string }>)[0]?.text);
    expect(prompts).toEqual(["a", "b"]);
    await headless.shutdown();
  });

  it("shares one process across sessions and kills it after the last close", async () => {
    const { headless } = await setup();
    const a = await headless.createSession({ agent: { provider: "codex", transport: "app-server" } });
    const b = await headless.createSession({ agent: { provider: "codex", transport: "app-server" } });
    expect(a.id).toBe("thread-1");
    expect(b.id).toBe("thread-2");
    expect(await a.run({ prompt: "A" })).toBe("echo:A");
    expect(await b.run({ prompt: "B" })).toBe("echo:B");

    let log = await readLog();
    expect(log.filter((entry) => entry.method === "initialize")).toHaveLength(1);
    expect(new Set(log.map((entry) => entry.pid)).size).toBe(1);

    // Closing one session keeps the runtime alive for the other.
    await a.close();
    expect(await b.run({ prompt: "B2" })).toBe("echo:B2");

    // Last close kills the process; a new session spawns a fresh runtime.
    await b.close();
    const c = await headless.createSession({ agent: { provider: "codex", transport: "app-server" } });
    expect(c.id).toBe("thread-1");
    log = await readLog();
    expect(log.filter((entry) => entry.method === "initialize")).toHaveLength(2);
    expect(new Set(log.map((entry) => entry.pid)).size).toBe(2);
    await headless.shutdown();
  });

  it("run() on a closed session fails with SESSION_CLOSED", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "codex", transport: "app-server" }
    });
    await session.close();
    await expectErrorCode(session.run({ prompt: "x" }), "SESSION_CLOSED");
    await headless.shutdown();
  });

  it("a crashed process rejects pending work and a fresh runtime starts on demand", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "codex", transport: "app-server" }
    });
    await expectErrorCode(session.run({ prompt: "KILL" }), "PROTOCOL_ERROR");
    await expectErrorCode(session.run({ prompt: "again" }), "PROTOCOL_ERROR");

    const fresh = await headless.createSession({
      agent: { provider: "codex", transport: "app-server" }
    });
    expect(await fresh.run({ prompt: "hi" })).toBe("echo:hi");
    const log = await readLog();
    expect(log.filter((entry) => entry.method === "initialize")).toHaveLength(2);
    expect(new Set(log.map((entry) => entry.pid)).size).toBe(2);
    await headless.shutdown();
  });

  it("thread/start failure during createSession rejects and releases", async () => {
    const { headless } = await setup();
    await expectErrorCode(
      headless.createSession({ agent: { provider: "codex", transport: "app-server", model: "__crash__" } }),
      "PROTOCOL_ERROR"
    );
    const session = await headless.createSession({
      agent: { provider: "codex", transport: "app-server" }
    });
    expect(await session.run({ prompt: "hi" })).toBe("echo:hi");
    await headless.shutdown();
  });

  it("shutdown() kills the runtime and breaks its sessions", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "codex", transport: "app-server" }
    });
    await headless.shutdown();
    await expectErrorCode(session.run({ prompt: "x" }), "PROTOCOL_ERROR");
  });
});

describe("devin acp sessions", () => {
  async function setup(): Promise<{ headless: HeadlessCore }> {
    const bin = await installFixture("fake-devin-acp.mjs");
    const headless = createHeadlessCore({
      env: { ...process.env, DEVIN_BIN: bin, FAKE_LOG: logPath }
    });
    return { headless };
  }

  it("initializes, opens an ACP session, and streams message chunks", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "devin", transport: "acp" }
    });
    expect(session.id).toBe("sess-1");

    const events: ProgressEvent[] = [];
    const output = await session.run({
      prompt: "hello",
      onProgress: (event) => {
        events.push(event);
      }
    });
    expect(output).toBe("echo:hello");
    expect(deltasOf(events)).toBe("echo:hello");

    const log = await readLog();
    expect(log.filter((entry) => entry.method === "initialize")).toHaveLength(1);
    expect(log.filter((entry) => entry.method === "session/new")).toHaveLength(1);
    // Read-only posture: the write-capable default mode is switched to "ask".
    expect(
      log.some(
        (entry) =>
          entry.method === "session/set_config_option" &&
          entry.params?.configId === "mode" &&
          entry.params?.value === "ask"
      )
    ).toBe(true);

    await session.close();
    await headless.shutdown();
  });

  it("reset() opens a new ACP session on the same process", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "devin", transport: "acp" }
    });
    expect(await session.run({ prompt: "first" })).toBe("echo:first");
    const firstId = session.id;

    await session.reset();
    expect(session.id).toBe("sess-2");
    expect(await session.run({ prompt: "second" })).toBe("echo:second");

    const log = await readLog();
    expect(
      log.some((entry) => entry.method === "session/delete" && entry.params?.sessionId === firstId)
    ).toBe(true);
    expect(new Set(log.map((entry) => entry.pid)).size).toBe(1);
    await headless.shutdown();
  });

  it("exposes model config options as available models", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "devin", transport: "acp" }
    });
    const models = await session.getAvailableModels();
    expect(models.map((model) => model.id)).toEqual([
      "m-a",
      "m-b",
      "fam-low",
      "fam-medium",
      "swe-2-high",
      "gpt-5-6-sol-medium",
      "glm-5-2",
      "gpt-5-4-low",
      "gpt-5-4-none",
      "claude-opus-4-6",
      "claude-opus-4-6-thinking"
    ]);
    await headless.shutdown();
  });

  it("setModel switches the model via session/set_config_option", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "devin", transport: "acp" }
    });
    await session.setModel("m-b");
    let log = await readLog();
    expect(
      log.some(
        (entry) =>
          entry.method === "session/set_config_option" &&
          entry.params?.configId === "model" &&
          entry.params?.value === "m-b"
      )
    ).toBe(true);

    // "<model>-<effort>" is preferred when the family variant exists.
    await session.setModel("fam", "low");
    log = await readLog();
    expect(
      log.some(
        (entry) =>
          entry.method === "session/set_config_option" &&
          entry.params?.configId === "model" &&
          entry.params?.value === "fam-low"
      )
    ).toBe(true);

    // Effort also maps onto the thought_level option when valid.
    await session.setModel("m-a", "medium");
    log = await readLog();
    expect(
      log.some(
        (entry) =>
          entry.method === "session/set_config_option" &&
          entry.params?.configId === "thought_level" &&
          entry.params?.value === "medium"
      )
    ).toBe(true);
    await headless.shutdown();
  });

  it("resolves family slugs to a unique advertised variant uid", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "devin", transport: "acp" }
    });
    // "swe-2" is not advertised, but swe-2-high is the family's only variant.
    await session.setModel("swe-2");
    const log = await readLog();
    expect(
      log.some(
        (entry) =>
          entry.method === "session/set_config_option" &&
          entry.params?.configId === "model" &&
          entry.params?.value === "swe-2-high"
      )
    ).toBe(true);
    await headless.shutdown();
  });

  it("rejects an effort the family has no variant for instead of converting", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "devin", transport: "acp" }
    });
    // swe-2 only advertises swe-2-high: "low" must not silently become high.
    const error = await expectEffortError(session.setModel("swe-2", "low"), "UNSUPPORTED_EFFORT");
    expect(error.supportedEfforts).toContain("high");
    const log = await readLog();
    expect(log.some((entry) => entry.params?.value === "swe-2-low")).toBe(false);
    await headless.shutdown();
  });

  it("maps none to an advertised non-reasoning variant uid", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "devin", transport: "acp" }
    });
    await session.setModel("gpt-5-4", "none");
    const log = await readLog();
    expect(
      log.some(
        (entry) =>
          entry.method === "session/set_config_option" &&
          entry.params?.configId === "model" &&
          entry.params?.value === "gpt-5-4-none"
      )
    ).toBe(true);
    await headless.shutdown();
  });

  it("maps none to the family's level-less sibling among thinking variants", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "devin", transport: "acp" }
    });
    // claude-opus-4-6 is the bare uid next to claude-opus-4-6-thinking.
    await session.setModel("claude-opus-4-6", "none");
    const log = await readLog();
    expect(
      log.some(
        (entry) =>
          entry.method === "session/set_config_option" &&
          entry.params?.configId === "model" &&
          entry.params?.value === "claude-opus-4-6"
      )
    ).toBe(true);
    await headless.shutdown();
  });

  it("rejects devin none when the family has no non-reasoning variant", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "devin", transport: "acp" }
    });
    const error = await expectEffortError(session.setModel("swe-2", "none"), "UNSUPPORTED_EFFORT");
    expect(error.supportedEfforts).not.toContain("none");
    const log = await readLog();
    expect(log.some((entry) => entry.params?.value === "swe-2-none")).toBe(false);
    await headless.shutdown();
  });

  it("resolves dotted family slugs to dashed variant uids", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "devin", transport: "acp", model: "gpt-5.6-sol" }
    });
    const log = await readLog();
    expect(
      log.some(
        (entry) =>
          entry.method === "session/set_config_option" &&
          entry.params?.configId === "model" &&
          entry.params?.value === "gpt-5-6-sol-medium"
      )
    ).toBe(true);
    await headless.shutdown();
  });

  it("rejects a family slug when several variants are advertised", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "devin", transport: "acp" }
    });
    // fam offers both fam-low and fam-medium, so a bare slug is ambiguous.
    await expectErrorCode(session.setModel("fam"), "PROTOCOL_ERROR");
    await headless.shutdown();
  });

  it("setModel default restores the session's initial model and thought level", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "devin", transport: "acp" }
    });
    await session.setModel("m-b", "medium");
    await session.setModel("default", "default");
    const log = await readLog();
    const modelSets = log.filter(
      (entry) => entry.method === "session/set_config_option" && entry.params?.configId === "model"
    );
    expect(modelSets.at(-1)?.params?.value).toBe("m-a");
    const thoughtSets = log.filter(
      (entry) =>
        entry.method === "session/set_config_option" && entry.params?.configId === "thought_level"
    );
    expect(thoughtSets.at(-1)?.params?.value).toBe("high");
    await headless.shutdown();
  });

  it("rejects an unknown model", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "devin", transport: "acp" }
    });
    await expectErrorCode(session.setModel("nope"), "PROTOCOL_ERROR");
    await headless.shutdown();
  });

  it("AbortSignal cancels the prompt", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "devin", transport: "acp" }
    });
    const controller = new AbortController();
    const pending = session.run({ prompt: "NEVER", signal: controller.signal });
    await waitForLog((log) => log.some((entry) => entry.method === "session/prompt"));
    controller.abort();

    await expectErrorCode(pending, "REQUEST_ABORTED");
    await waitForLog((log) => log.some((entry) => entry.method === "session/cancel"));
    expect(await session.run({ prompt: "ok" })).toBe("echo:ok");
    await headless.shutdown();
  });

  it("timeoutMs cancels the prompt", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "devin", transport: "acp" }
    });
    await expectErrorCode(session.run({ prompt: "SLOW", timeoutMs: 200 }), "REQUEST_TIMEOUT");
    await waitForLog((log) => log.some((entry) => entry.method === "session/cancel"));
    expect(await session.run({ prompt: "ok" })).toBe("echo:ok");
    await headless.shutdown();
  });

  it("shares one process across sessions", async () => {
    const { headless } = await setup();
    const a = await headless.createSession({ agent: { provider: "devin", transport: "acp" } });
    const b = await headless.createSession({ agent: { provider: "devin", transport: "acp" } });
    expect(a.id).toBe("sess-1");
    expect(b.id).toBe("sess-2");
    expect(await a.run({ prompt: "A" })).toBe("echo:A");
    expect(await b.run({ prompt: "B" })).toBe("echo:B");
    const log = await readLog();
    expect(log.filter((entry) => entry.method === "initialize")).toHaveLength(1);
    expect(new Set(log.map((entry) => entry.pid)).size).toBe(1);
    await headless.shutdown();
  });

  it("close() deletes the ACP session and the last close kills the process", async () => {
    const { headless } = await setup();
    const a = await headless.createSession({ agent: { provider: "devin", transport: "acp" } });
    await a.close();
    const log = await readLog();
    expect(
      log.some((entry) => entry.method === "session/delete" && entry.params?.sessionId === "sess-1")
    ).toBe(true);

    const b = await headless.createSession({ agent: { provider: "devin", transport: "acp" } });
    const newLog = await readLog();
    expect(newLog.filter((entry) => entry.method === "initialize")).toHaveLength(2);
    await b.close();
    await headless.shutdown();
  });

  it("denies permission requests without hanging", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "devin", transport: "acp" }
    });
    const output = await session.run({ prompt: "PERM", timeoutMs: 5000 });
    expect(output).toBe("perm-answered");
    const log = await readLog();
    const answer = log.find((entry) => entry.method === "_response_to_agent");
    expect((answer?.result as { outcome?: { optionId?: string } })?.outcome?.optionId).toBe("reject");
    await headless.shutdown();
  });

  it("a crashed process rejects pending work and a fresh runtime starts on demand", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "devin", transport: "acp" }
    });
    await expectErrorCode(session.run({ prompt: "KILL" }), "PROTOCOL_ERROR");
    await expectErrorCode(session.run({ prompt: "again" }), "PROTOCOL_ERROR");

    const fresh = await headless.createSession({ agent: { provider: "devin", transport: "acp" } });
    expect(await fresh.run({ prompt: "hi" })).toBe("echo:hi");
    const log = await readLog();
    expect(log.filter((entry) => entry.method === "initialize")).toHaveLength(2);
    await headless.shutdown();
  });
});

describe("agy acp sessions", () => {
  async function setup(extraEnv: NodeJS.ProcessEnv = {}): Promise<{ headless: HeadlessCore }> {
    const bin = await installFixture("fake-agy-acp-server.mjs");
    const headless = createHeadlessCore({
      env: { ...process.env, AGY_ACP_BIN: bin, FAKE_LOG: logPath, ...extraEnv }
    });
    return { headless };
  }

  it("initializes, opens an ACP session, and streams message chunks", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "agy", transport: "acp" }
    });
    expect(session.id).toBe("agy-sess-1");

    const events: ProgressEvent[] = [];
    const output = await session.run({
      prompt: "hello",
      onProgress: (event) => {
        events.push(event);
      }
    });
    expect(output).toBe("echo:hello");
    expect(deltasOf(events)).toBe("echo:hello");

    const log = await readLog();
    expect(log.filter((entry) => entry.method === "initialize")).toHaveLength(1);
    expect(log.filter((entry) => entry.method === "session/new")).toHaveLength(1);
    // Parity with `agy --print --mode accept-edits`: the writable auto_edit
    // mode (the real server's name for accept-edits) is selected on start.
    expect(
      log.some(
        (entry) =>
          entry.method === "session/set_config_option" &&
          entry.params?.configId === "mode" &&
          entry.params?.value === "auto_edit"
      )
    ).toBe(true);

    await session.close();
    await headless.shutdown();
  });

  it("honors headless.run() over the acp transport", async () => {
    const { headless } = await setup();
    const output = await headless.run({
      agent: { provider: "agy", transport: "acp" },
      prompt: "oneshot"
    });
    expect(output).toBe("echo:oneshot");
    await headless.shutdown();
  });

  it("reset() opens a new ACP session on the same process", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "agy", transport: "acp" }
    });
    expect(await session.run({ prompt: "first" })).toBe("echo:first");
    const firstId = session.id;

    await session.reset();
    expect(session.id).toBe("agy-sess-2");
    expect(await session.run({ prompt: "second" })).toBe("echo:second");

    const log = await readLog();
    expect(
      log.some((entry) => entry.method === "session/close" && entry.params?.sessionId === firstId)
    ).toBe(true);
    expect(new Set(log.map((entry) => entry.pid)).size).toBe(1);
    await headless.shutdown();
  });

  it("exposes model config options as available models", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "agy", transport: "acp" }
    });
    const models = await session.getAvailableModels();
    expect(models.map((model) => model.id)).toEqual([
      "gem-3",
      "m-plain",
      "gem-1",
      "gem-1-low",
      "gem-1-high",
      "gem-2-none",
      "gem-2-medium"
    ]);
    await headless.shutdown();
  });

  it("setModel folds the effort into an advertised variant id", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "agy", transport: "acp" }
    });
    await session.setModel("gem-1", "low");
    const log = await readLog();
    expect(
      log.some(
        (entry) =>
          entry.method === "session/set_config_option" &&
          entry.params?.configId === "model" &&
          entry.params?.value === "gem-1-low"
      )
    ).toBe(true);
    // The variant carries the level — no separate effort call is made.
    expect(
      log.some(
        (entry) =>
          entry.method === "session/set_config_option" && entry.params?.configId === "effort"
      )
    ).toBe(false);
    await headless.shutdown();
  });

  it("applies a flag-range effort via the effort config option", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "agy", transport: "acp" }
    });
    await session.setModel("m-plain", "medium");
    const log = await readLog();
    expect(
      log.some(
        (entry) =>
          entry.method === "session/set_config_option" &&
          entry.params?.configId === "model" &&
          entry.params?.value === "m-plain"
      )
    ).toBe(true);
    expect(
      log.some(
        (entry) =>
          entry.method === "session/set_config_option" &&
          entry.params?.configId === "effort" &&
          entry.params?.value === "medium"
      )
    ).toBe(true);
    await headless.shutdown();
  });

  it("maps none to an advertised non-thinking variant", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "agy", transport: "acp" }
    });
    await session.setModel("gem-2", "none");
    const log = await readLog();
    expect(
      log.some(
        (entry) =>
          entry.method === "session/set_config_option" &&
          entry.params?.configId === "model" &&
          entry.params?.value === "gem-2-none"
      )
    ).toBe(true);
    await headless.shutdown();
  });

  it("rejects an effort the family cannot express", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "agy", transport: "acp" }
    });
    const error = await expectEffortError(session.setModel("gem-1", "xhigh"), "UNSUPPORTED_EFFORT");
    expect(error.supportedEfforts).toContain("high");
    const log = await readLog();
    expect(log.some((entry) => entry.params?.value === "gem-1-xhigh")).toBe(false);
    await headless.shutdown();
  });

  it("rejects a flag effort when the session exposes no effort option", async () => {
    const { headless } = await setup({ FAKE_NO_EFFORT: "1" });
    const session = await headless.createSession({
      agent: { provider: "agy", transport: "acp" }
    });
    await expectEffortError(session.setModel("m-plain", "medium"), "UNSUPPORTED_EFFORT");
    await headless.shutdown();
  });

  it("applies effort without a model via the effort option", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "agy", transport: "acp" }
    });
    await session.setModel("default", "high");
    const log = await readLog();
    expect(
      log.some(
        (entry) =>
          entry.method === "session/set_config_option" &&
          entry.params?.configId === "effort" &&
          entry.params?.value === "high"
      )
    ).toBe(true);
    await headless.shutdown();
  });

  it("setModel default restores the session's initial model and effort", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "agy", transport: "acp" }
    });
    await session.setModel("m-plain", "low");
    await session.setModel("default", "default");
    const log = await readLog();
    const modelSets = log.filter(
      (entry) => entry.method === "session/set_config_option" && entry.params?.configId === "model"
    );
    expect(modelSets.at(-1)?.params?.value).toBe("gem-3");
    const effortSets = log.filter(
      (entry) => entry.method === "session/set_config_option" && entry.params?.configId === "effort"
    );
    expect(effortSets.at(-1)?.params?.value).toBe("medium");
    await headless.shutdown();
  });

  it("falls back to session/set_mode when no mode config option exists", async () => {
    const { headless } = await setup({ FAKE_MODES_ONLY: "1" });
    await headless.createSession({ agent: { provider: "agy", transport: "acp" } });
    const log = await readLog();
    expect(
      log.some(
        (entry) => entry.method === "session/set_mode" && entry.params?.modeId === "auto_edit"
      )
    ).toBe(true);
    await headless.shutdown();
  });

  it("authenticates before session/new when the server advertises auth methods", async () => {
    const { headless } = await setup({ FAKE_AUTH: "1" });
    const session = await headless.createSession({
      agent: { provider: "agy", transport: "acp" }
    });
    expect(await session.run({ prompt: "hi" })).toBe("echo:hi");
    const log = await readLog();
    const authenticate = log.findIndex((entry) => entry.method === "authenticate");
    const sessionNew = log.findIndex((entry) => entry.method === "session/new");
    expect(authenticate).toBeGreaterThanOrEqual(0);
    expect(authenticate).toBeLessThan(sessionNew);
    expect(
      (log[authenticate]?.params as { methodId?: string } | undefined)?.methodId
    ).toBe("oauth-personal");
    await headless.shutdown();
  });

  it("rejects an invalid effort string before the session starts", async () => {
    const { headless } = await setup();
    await expectEffortError(
      headless.createSession({
        agent: { provider: "agy", transport: "acp", reasoningEffort: "banana" }
      }),
      "INVALID_EFFORT"
    );
    const log = await readLog();
    expect(log.some((entry) => entry.method === "session/new")).toBe(false);
    await headless.shutdown();
  });

  it("AbortSignal cancels the prompt", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "agy", transport: "acp" }
    });
    const controller = new AbortController();
    const pending = session.run({ prompt: "NEVER", signal: controller.signal });
    await waitForLog((log) => log.some((entry) => entry.method === "session/prompt"));
    controller.abort();

    await expectErrorCode(pending, "REQUEST_ABORTED");
    await waitForLog((log) => log.some((entry) => entry.method === "session/cancel"));
    expect(await session.run({ prompt: "ok" })).toBe("echo:ok");
    await headless.shutdown();
  });

  it("timeoutMs cancels the prompt", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "agy", transport: "acp" }
    });
    await expectErrorCode(session.run({ prompt: "SLOW", timeoutMs: 200 }), "REQUEST_TIMEOUT");
    await waitForLog((log) => log.some((entry) => entry.method === "session/cancel"));
    expect(await session.run({ prompt: "ok" })).toBe("echo:ok");
    await headless.shutdown();
  });

  it("auto-approves permission requests like --dangerously-skip-permissions", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "agy", transport: "acp" }
    });
    const output = await session.run({ prompt: "PERM", timeoutMs: 5000 });
    expect(output).toBe("perm-answered");
    const log = await readLog();
    const answer = log.find((entry) => entry.method === "_response_to_agent");
    expect((answer?.result as { outcome?: { optionId?: string } })?.outcome?.optionId).toBe("allow");
    await headless.shutdown();
  });

  it("shares one process across sessions and kills it after the last close", async () => {
    const { headless } = await setup();
    const a = await headless.createSession({ agent: { provider: "agy", transport: "acp" } });
    const b = await headless.createSession({ agent: { provider: "agy", transport: "acp" } });
    expect(a.id).toBe("agy-sess-1");
    expect(b.id).toBe("agy-sess-2");
    expect(await a.run({ prompt: "A" })).toBe("echo:A");
    expect(await b.run({ prompt: "B" })).toBe("echo:B");

    let log = await readLog();
    expect(log.filter((entry) => entry.method === "initialize")).toHaveLength(1);
    expect(new Set(log.map((entry) => entry.pid)).size).toBe(1);

    await a.close();
    expect(await b.run({ prompt: "B2" })).toBe("echo:B2");

    await b.close();
    const c = await headless.createSession({ agent: { provider: "agy", transport: "acp" } });
    expect(c.id).toBe("agy-sess-1");
    log = await readLog();
    expect(log.filter((entry) => entry.method === "initialize")).toHaveLength(2);
    expect(new Set(log.map((entry) => entry.pid)).size).toBe(2);
    await headless.shutdown();
  });

  it("a crashed process rejects pending work and a fresh runtime starts on demand", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "agy", transport: "acp" }
    });
    await expectErrorCode(session.run({ prompt: "KILL" }), "PROTOCOL_ERROR");
    await expectErrorCode(session.run({ prompt: "again" }), "PROTOCOL_ERROR");

    const fresh = await headless.createSession({
      agent: { provider: "agy", transport: "acp" }
    });
    expect(await fresh.run({ prompt: "hi" })).toBe("echo:hi");
    const log = await readLog();
    expect(log.filter((entry) => entry.method === "initialize")).toHaveLength(2);
    await headless.shutdown();
  });
});

describe("grok acp sessions", () => {
  async function setup(extraEnv: NodeJS.ProcessEnv = {}): Promise<{ headless: HeadlessCore }> {
    const bin = await installFixture("fake-grok-acp.mjs");
    const headless = createHeadlessCore({
      env: { ...process.env, GROK_BIN: bin, FAKE_LOG: logPath, ...extraEnv }
    });
    return { headless };
  }

  it("spawns `grok agent --always-approve stdio` and streams message chunks", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "grok", transport: "acp" }
    });
    expect(session.id).toBe("grok-sess-1");

    const events: ProgressEvent[] = [];
    const output = await session.run({
      prompt: "hello",
      onProgress: (event) => {
        events.push(event);
      }
    });
    expect(output).toBe("echo:hello");
    expect(deltasOf(events)).toBe("echo:hello");

    const log = await readLog();
    expect(log.filter((entry) => entry.method === "initialize")).toHaveLength(1);
    expect(log.filter((entry) => entry.method === "session/new")).toHaveLength(1);
    const spawnEntry = log.find((entry) => entry.method === "_spawn");
    expect(spawnEntry?.argv).toEqual(["agent", "--always-approve", "stdio"]);

    await session.close();
    await headless.shutdown();
  });

  it("honors headless.run() over the acp transport", async () => {
    const { headless } = await setup();
    const output = await headless.run({
      agent: { provider: "grok", transport: "acp" },
      prompt: "oneshot"
    });
    expect(output).toBe("echo:oneshot");
    await headless.shutdown();
  });

  it("reset() opens a new ACP session on the same process", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "grok", transport: "acp" }
    });
    expect(await session.run({ prompt: "first" })).toBe("echo:first");
    const firstId = session.id;

    await session.reset();
    expect(session.id).toBe("grok-sess-2");
    expect(await session.run({ prompt: "second" })).toBe("echo:second");

    const log = await readLog();
    expect(
      log.some((entry) => entry.method === "session/close" && entry.params?.sessionId === firstId)
    ).toBe(true);
    expect(new Set(log.map((entry) => entry.pid)).size).toBe(1);
    await headless.shutdown();
  });

  it("exposes the models catalog as available models", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "grok", transport: "acp" }
    });
    const models = await session.getAvailableModels();
    expect(models.map((model) => model.id)).toEqual(["grok-a", "grok-b", "grok-c"]);
    expect(models[0]?.reasoningEfforts).toEqual(["xhigh", "high", "medium", "low"]);
    expect(models[2]?.reasoningEfforts).toBeUndefined();
    await headless.shutdown();
  });

  it("setModel switches model and effort via session/set_config_option", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "grok", transport: "acp" }
    });
    await session.setModel("grok-b", "low");
    const log = await readLog();
    expect(
      log.some(
        (entry) =>
          entry.method === "session/set_config_option" &&
          entry.params?.configId === "model" &&
          entry.params?.value === "grok-b"
      )
    ).toBe(true);
    expect(
      log.some(
        (entry) =>
          entry.method === "session/set_config_option" &&
          entry.params?.configId === "reasoning_effort" &&
          entry.params?.value === "low"
      )
    ).toBe(true);
    await headless.shutdown();
  });

  it("rejects an effort the selected model does not advertise", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "grok", transport: "acp" }
    });
    // grok-b advertises only medium/low: xhigh must not be sent to the server.
    const error = await expectEffortError(session.setModel("grok-b", "xhigh"), "UNSUPPORTED_EFFORT");
    expect(error.supportedEfforts).toEqual(["low", "medium"]);
    const log = await readLog();
    expect(log.some((entry) => entry.params?.value === "xhigh")).toBe(false);
    await headless.shutdown();
  });

  it("rejects effort on a model that does not support reasoning effort", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "grok", transport: "acp" }
    });
    const error = await expectEffortError(session.setModel("grok-c", "low"), "UNSUPPORTED_EFFORT");
    expect(error.supportedEfforts).toEqual([]);
    await headless.shutdown();
  });

  it("applies effort without a model via the effort option", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "grok", transport: "acp" }
    });
    await session.setModel("default", "medium");
    const log = await readLog();
    expect(
      log.some(
        (entry) =>
          entry.method === "session/set_config_option" &&
          entry.params?.configId === "reasoning_effort" &&
          entry.params?.value === "medium"
      )
    ).toBe(true);
    await headless.shutdown();
  });

  it("rejects an effort beyond the current model's levels", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "grok", transport: "acp" }
    });
    // "max" is valid vocabulary but outside grok-a's advertised levels.
    const error = await expectEffortError(session.setModel("default", "max"), "UNSUPPORTED_EFFORT");
    expect(error.supportedEfforts).toEqual(["low", "medium", "high", "xhigh"]);
    await headless.shutdown();
  });

  it("setModel default restores the session's initial model and effort", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "grok", transport: "acp" }
    });
    await session.setModel("grok-b", "low");
    await session.setModel("default", "default");
    const log = await readLog();
    const modelSets = log.filter(
      (entry) => entry.method === "session/set_config_option" && entry.params?.configId === "model"
    );
    expect(modelSets.at(-1)?.params?.value).toBe("grok-a");
    const effortSets = log.filter(
      (entry) =>
        entry.method === "session/set_config_option" && entry.params?.configId === "reasoning_effort"
    );
    expect(effortSets.at(-1)?.params?.value).toBe("high");
    await headless.shutdown();
  });

  it("rejects an unknown model", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "grok", transport: "acp" }
    });
    await expectErrorCode(session.setModel("nope"), "PROTOCOL_ERROR");
    await headless.shutdown();
  });

  it("rejects a model when the session exposes no model channel", async () => {
    const { headless } = await setup({ FAKE_NO_MODELS: "1" });
    const session = await headless.createSession({
      agent: { provider: "grok", transport: "acp" }
    });
    await expectErrorCode(session.setModel("grok-b"), "PROTOCOL_ERROR");
    expect(await session.getAvailableModels()).toEqual([]);
    await headless.shutdown();
  });

  it("falls back to session/set_model when no model config option exists", async () => {
    const { headless } = await setup({ FAKE_NO_MODEL_OPTION: "1" });
    const session = await headless.createSession({
      agent: { provider: "grok", transport: "acp" }
    });
    await session.setModel("grok-b");
    const log = await readLog();
    expect(
      log.some(
        (entry) => entry.method === "session/set_model" && entry.params?.modelId === "grok-b"
      )
    ).toBe(true);
    // The models catalog still drives getAvailableModels.
    expect((await session.getAvailableModels()).map((model) => model.id)).toEqual([
      "grok-a",
      "grok-b",
      "grok-c"
    ]);
    await headless.shutdown();
  });

  it("rejects an invalid effort string before the session starts", async () => {
    const { headless } = await setup();
    await expectEffortError(
      headless.createSession({
        agent: { provider: "grok", transport: "acp", reasoningEffort: "banana" }
      }),
      "INVALID_EFFORT"
    );
    const log = await readLog();
    expect(log.some((entry) => entry.method === "session/new")).toBe(false);
    await headless.shutdown();
  });

  it("authenticates with the advertised default method when the server requires it", async () => {
    const { headless } = await setup({ FAKE_AUTH: "1" });
    const session = await headless.createSession({
      agent: { provider: "grok", transport: "acp" }
    });
    expect(await session.run({ prompt: "hi" })).toBe("echo:hi");
    const log = await readLog();
    const authenticate = log.findIndex((entry) => entry.method === "authenticate");
    const sessionNew = log.findIndex((entry) => entry.method === "session/new");
    expect(authenticate).toBeGreaterThanOrEqual(0);
    expect(authenticate).toBeLessThan(sessionNew);
    expect(
      (log[authenticate]?.params as { methodId?: string } | undefined)?.methodId
    ).toBe("cached_token");
    await headless.shutdown();
  });

  it("auto-approves permission requests like `grok --single` headless runs", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "grok", transport: "acp" }
    });
    const output = await session.run({ prompt: "PERM", timeoutMs: 5000 });
    expect(output).toBe("perm-answered");
    const log = await readLog();
    const answer = log.find((entry) => entry.method === "_response_to_agent");
    expect((answer?.result as { outcome?: { optionId?: string } })?.outcome?.optionId).toBe("allow");
    await headless.shutdown();
  });

  it("AbortSignal cancels the prompt", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "grok", transport: "acp" }
    });
    const controller = new AbortController();
    const pending = session.run({ prompt: "NEVER", signal: controller.signal });
    await waitForLog((log) => log.some((entry) => entry.method === "session/prompt"));
    controller.abort();

    await expectErrorCode(pending, "REQUEST_ABORTED");
    await waitForLog((log) => log.some((entry) => entry.method === "session/cancel"));
    expect(await session.run({ prompt: "ok" })).toBe("echo:ok");
    await headless.shutdown();
  });

  it("timeoutMs cancels the prompt", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "grok", transport: "acp" }
    });
    await expectErrorCode(session.run({ prompt: "SLOW", timeoutMs: 200 }), "REQUEST_TIMEOUT");
    await waitForLog((log) => log.some((entry) => entry.method === "session/cancel"));
    expect(await session.run({ prompt: "ok" })).toBe("echo:ok");
    await headless.shutdown();
  });

  it("shares one process across sessions and kills it after the last close", async () => {
    const { headless } = await setup();
    const a = await headless.createSession({ agent: { provider: "grok", transport: "acp" } });
    const b = await headless.createSession({ agent: { provider: "grok", transport: "acp" } });
    expect(a.id).toBe("grok-sess-1");
    expect(b.id).toBe("grok-sess-2");
    expect(await a.run({ prompt: "A" })).toBe("echo:A");
    expect(await b.run({ prompt: "B" })).toBe("echo:B");

    let log = await readLog();
    expect(log.filter((entry) => entry.method === "initialize")).toHaveLength(1);
    expect(new Set(log.map((entry) => entry.pid)).size).toBe(1);

    await a.close();
    expect(await b.run({ prompt: "B2" })).toBe("echo:B2");

    await b.close();
    const c = await headless.createSession({ agent: { provider: "grok", transport: "acp" } });
    expect(c.id).toBe("grok-sess-1");
    log = await readLog();
    expect(log.filter((entry) => entry.method === "initialize")).toHaveLength(2);
    expect(new Set(log.map((entry) => entry.pid)).size).toBe(2);
    await headless.shutdown();
  });

  it("run() on a closed session fails with SESSION_CLOSED", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "grok", transport: "acp" }
    });
    await session.close();
    await expectErrorCode(session.run({ prompt: "x" }), "SESSION_CLOSED");
    await headless.shutdown();
  });

  it("a crashed process rejects pending work and a fresh runtime starts on demand", async () => {
    const { headless } = await setup();
    const session = await headless.createSession({
      agent: { provider: "grok", transport: "acp" }
    });
    await expectErrorCode(session.run({ prompt: "KILL" }), "PROTOCOL_ERROR");
    await expectErrorCode(session.run({ prompt: "again" }), "PROTOCOL_ERROR");

    const fresh = await headless.createSession({
      agent: { provider: "grok", transport: "acp" }
    });
    expect(await fresh.run({ prompt: "hi" })).toBe("echo:hi");
    const log = await readLog();
    expect(log.filter((entry) => entry.method === "initialize")).toHaveLength(2);
    await headless.shutdown();
  });
});

describe("transport validation and cli sessions", () => {
  it("rejects unsupported provider/transport combinations", async () => {
    const headless = createHeadlessCore({ env: { ...process.env } });
    await expectErrorCode(
      headless.createSession({ agent: { provider: "codex", transport: "acp" } }),
      "UNSUPPORTED_TRANSPORT"
    );
    await expectErrorCode(
      headless.createSession({ agent: { provider: "agy", transport: "app-server" } }),
      "UNSUPPORTED_TRANSPORT"
    );
    await expectErrorCode(
      headless.createSession({ agent: { provider: "grok", transport: "app-server" } }),
      "UNSUPPORTED_TRANSPORT"
    );
    await expectErrorCode(
      headless.createSession({ agent: { provider: "devin", transport: "app-server" } }),
      "UNSUPPORTED_TRANSPORT"
    );
    await expectErrorCode(
      headless.createSession({ agent: { provider: "claude", transport: "acp" } }),
      "UNSUPPORTED_TRANSPORT"
    );
  });

  it("createSession without transport stays a stateless CLI session", async () => {
    const bin = path.join(tmpDir, "fake-codex-cli.mjs");
    await writeFile(bin, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
    await chmod(bin, 0o755);
    const headless = createHeadlessCore({ env: { ...process.env, CODEX_BIN: bin } });

    const session: HeadlessSession = await headless.createSession({ agent: { provider: "codex" } });
    expect(session.transport).toBe("cli");
    expect(session.id).toBeNull();

    const output = await session.run({ prompt: "hello" });
    expect(JSON.parse(output).at(-1)).toBe("hello");

    await session.reset();
    await session.close();
    await expectErrorCode(session.run({ prompt: "x" }), "SESSION_CLOSED");
  });
});
