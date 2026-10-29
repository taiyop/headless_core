import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHeadlessCore, ToolsError, type HeadlessCore, type ProgressEvent } from "../src/index.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

let tmpDir: string;
let headless: HeadlessCore;

beforeEach(async () => {
  tmpDir = await realpath(await mkdtemp(path.join(tmpdir(), "headless-core-tools-test-")));
  const bin = path.join(tmpDir, "claude");
  await writeFile(bin, await readFile(path.join(FIXTURES, "fake-claude-cli.mjs"), "utf8"));
  await chmod(bin, 0o755);
  headless = createHeadlessCore({ cwd: tmpDir, timeoutMs: 5_000, env: { ...process.env, CLAUDE_BIN: bin } });
});

afterEach(async () => {
  await headless.shutdown();
  await rm(tmpDir, { force: true, recursive: true });
});

const TOOLS = {
  allow: ["Bash", "Read", "WebFetch"],
  permissionMode: "dontAsk" as const,
  allowedRules: ["Bash(git clone:*)", "WebFetch(domain:github.com)"]
};

describe("claude cli tools", () => {
  it("delivers the prompt to claude 2.1.x despite the variadic --tools option", async () => {
    // No model/effort: the prompt directly follows `--tools ""`.
    await expect(headless.run({ agent: { provider: "claude" }, prompt: "hello" })).resolves.toBe("PROMPT:hello");
    await expect(headless.run({ agent: { provider: "claude", model: "haiku" }, prompt: "-dash" })).resolves.toBe(
      "PROMPT:-dash"
    );
  });

  it("keeps the text-only arguments when tools.allow is empty", async () => {
    await expect(
      headless.run({ agent: { provider: "claude", tools: { allow: [] } }, prompt: "hello" })
    ).resolves.toBe("PROMPT:hello");
  });

  it("maps tools to stream-json flags and returns the result message", async () => {
    const output = await headless.run({ agent: { provider: "claude", tools: TOOLS }, prompt: "summarize" });
    expect(JSON.parse(output)).toEqual({
      prompt: "summarize",
      tools: ["Bash", "Read", "WebFetch"],
      permissionMode: "dontAsk",
      permissionPrompts: "none",
      allowedTools: ["Bash(git clone:*)", "WebFetch(domain:github.com)"],
      partial: true,
      cwd: tmpDir
    });
  });

  it("defaults permissionMode to dontAsk", async () => {
    const output = await headless.run({ agent: { provider: "claude", tools: { allow: ["Read"] } }, prompt: "x" });
    expect(JSON.parse(output)).toMatchObject({ tools: ["Read"], permissionMode: "dontAsk", allowedTools: [] });
  });

  it("streams top-level text deltas and tool calls as progress events", async () => {
    const events: ProgressEvent[] = [];
    const output = await headless.run({
      agent: { provider: "claude", tools: TOOLS },
      prompt: "use a tool",
      onProgress: (event) => void events.push(event)
    });

    expect(events[0]?.state).toBe("starting");
    expect(events.filter((event) => event.partialOutput && event.state === "running").map((e) => e.partialOutput)).toEqual([
      "Hel",
      "lo"
    ]);
    expect(events.flatMap((event) => (event.toolUse ? [event.toolUse] : []))).toEqual([
      { id: "t1", name: "Bash", status: "started", input: { command: "git clone https://example.com/repo" } },
      { id: "t2", name: "Bash", status: "started", input: { command: "ls /" } },
      { id: "t2", name: "Bash", status: "denied", output: "Permission denied" },
      { id: "t1", name: "Bash", status: "completed", output: "Cloning into 'repo'..." }
    ]);
    expect(events.find((event) => event.toolUse?.status === "denied")).toMatchObject({
      state: "running",
      message: "Bash denied"
    });
    expect(events.at(-1)).toMatchObject({ state: "completed", partialOutput: output });
  });

  it("uses the per-run cwd override", async () => {
    const work = path.join(tmpDir, "conv-1");
    await mkdir(work);
    const output = await headless.run({ agent: { provider: "claude", tools: TOOLS }, prompt: "x", cwd: work });
    expect(JSON.parse(output).cwd).toBe(work);

    const session = await headless.createSession({ agent: { provider: "claude", tools: TOOLS }, cwd: work });
    expect(JSON.parse(await session.run({ prompt: "y" })).cwd).toBe(work);
  });

  it("fails with the result error and the streamed text as partial output", async () => {
    const events: ProgressEvent[] = [];
    const error = await headless
      .run({ agent: { provider: "claude", tools: TOOLS }, prompt: "error", onProgress: (e) => void events.push(e) })
      .catch((cause: unknown) => cause);
    expect((error as Error).message).toBe("API Error: 429 rate limit");
    expect(events.at(-1)).toMatchObject({
      state: "failed",
      partialOutput: "Hello",
      error: { kind: "rate_limit", message: "API Error: 429 rate limit" }
    });
  });

  it("fails when claude exits without a result message", async () => {
    await expect(headless.run({ agent: { provider: "claude", tools: TOOLS }, prompt: "no-result" })).rejects.toThrow(
      "claude exited without a result"
    );
  });

  it("reports timeouts as agent_stopped, distinct from denials", async () => {
    const events: ProgressEvent[] = [];
    const error = await headless
      .run({
        agent: { provider: "claude", tools: TOOLS },
        prompt: "hang",
        timeoutMs: 300,
        onProgress: (event) => void events.push(event)
      })
      .catch((cause: unknown) => cause);
    expect((error as Error).message).toContain("timed out");
    expect(events.at(-1)).toMatchObject({ state: "failed", error: { kind: "agent_stopped" } });
  });

  it("rejects tools for other providers without running fallback", async () => {
    let fallbackCalled = false;
    const error = await headless
      .run({
        agent: { provider: "codex", tools: TOOLS },
        prompt: "x",
        onFallback: () => {
          fallbackCalled = true;
          return { type: "fail" };
        }
      })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ToolsError);
    expect((error as ToolsError).code).toBe("UNSUPPORTED_TOOLS");
    expect(fallbackCalled).toBe(false);

    const sessionError = await headless
      .createSession({ agent: { provider: "devin", transport: "acp", tools: TOOLS } })
      .catch((cause: unknown) => cause);
    expect((sessionError as ToolsError).code).toBe("UNSUPPORTED_TOOLS");
  });

  it("rejects malformed tool specs", async () => {
    const invalid = [
      { allow: "Bash" },
      { allow: ["Bash", ""] },
      { allow: ["Bash"], permissionMode: "default" },
      { allow: ["Bash"], allowedRules: [1] }
    ];
    for (const tools of invalid) {
      const error = await headless
        .run({ agent: { provider: "claude", tools: tools as never }, prompt: "x" })
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(ToolsError);
      expect((error as ToolsError).code).toBe("INVALID_TOOLS");
    }
  });
});
