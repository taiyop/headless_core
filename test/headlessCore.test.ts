import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHeadlessCore, DEFAULT_MODEL_ID, DEFAULT_REASONING_EFFORT_ID, type ProgressEvent } from "../src/index.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "headless-core-run-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { force: true, recursive: true });
});

describe("createHeadlessCore", () => {
  it("runs codex with model and reasoning effort mapped to reasoning args", async () => {
    const bin = await writeExecutable(
      "fake-codex.mjs",
      [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify(process.argv.slice(2)));"
      ].join("\n")
    );
    const headless = createHeadlessCore({ env: { ...process.env, CODEX_BIN: bin } });

    const output = await headless.run({
      agent: { provider: "codex", model: "gpt-5.5", reasoningEffort: "low" },
      prompt: "hello"
    });

    expect(JSON.parse(output)).toEqual([
      "exec",
      "--model",
      "gpt-5.5",
      "--config",
      'approval_policy="never"',
      "--config",
      'model_reasoning_effort="low"',
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--color",
      "never",
      "hello"
    ]);
  });

  it("omits model args when the default model is selected", async () => {
    const bin = await writeExecutable(
      "fake-codex-default.mjs",
      [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify(process.argv.slice(2)));"
      ].join("\n")
    );
    const headless = createHeadlessCore({ env: { ...process.env, CODEX_BIN: bin } });

    const output = await headless.run({
      agent: { provider: "codex", model: DEFAULT_MODEL_ID },
      prompt: "hello"
    });

    expect(JSON.parse(output)).toEqual([
      "exec",
      "--config",
      'approval_policy="never"',
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--color",
      "never",
      "hello"
    ]);
  });

  it("omits reasoning effort args when the default reasoning effort is selected", async () => {
    const bin = await writeExecutable(
      "fake-codex-default-reasoning-effort.mjs",
      [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify(process.argv.slice(2)));"
      ].join("\n")
    );
    const headless = createHeadlessCore({ env: { ...process.env, CODEX_BIN: bin } });

    const output = await headless.run({
      agent: { provider: "codex", model: "gpt-5.5", reasoningEffort: DEFAULT_REASONING_EFFORT_ID },
      prompt: "hello"
    });

    expect(JSON.parse(output)).toEqual([
      "exec",
      "--model",
      "gpt-5.5",
      "--config",
      'approval_policy="never"',
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--color",
      "never",
      "hello"
    ]);
  });

  it("runs claude with model and reasoning effort mapped to effort args", async () => {
    const bin = await writeExecutable(
      "fake-claude.mjs",
      [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify(process.argv.slice(2)));"
      ].join("\n")
    );
    const headless = createHeadlessCore({ env: { ...process.env, CLAUDE_BIN: bin } });

    const output = await headless.run({
      agent: { provider: "claude", model: "opus", reasoningEffort: "xhigh" },
      prompt: "hello"
    });

    expect(JSON.parse(output)).toEqual([
      "--print",
      "--output-format",
      "text",
      "--tools",
      "",
      "--model",
      "opus",
      "--effort",
      "xhigh",
      "hello"
    ]);
  });

  it("runs agy with skip-permissions, accept-edits, and timeout-aligned print-timeout", async () => {
    const bin = await writeExecutable(
      "fake-agy.mjs",
      [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify(process.argv.slice(2)));"
      ].join("\n")
    );
    const headless = createHeadlessCore({ env: { ...process.env, AGY_BIN: bin } });

    const output = await headless.run({
      agent: { provider: "agy", model: "gemini-3.5-flash" },
      prompt: "create image",
      timeoutMs: 300_000
    });

    expect(JSON.parse(output)).toEqual([
      "--model",
      "gemini-3.5-flash",
      "--dangerously-skip-permissions",
      "--mode",
      "accept-edits",
      "--print-timeout",
      "5m",
      "--print",
      "create image"
    ]);
  });

  it("omits agy model args when the default model is selected", async () => {
    const bin = await writeExecutable(
      "fake-agy-default.mjs",
      [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify(process.argv.slice(2)));"
      ].join("\n")
    );
    const headless = createHeadlessCore({
      env: { ...process.env, AGY_BIN: bin },
      timeoutMs: 120_000
    });

    const output = await headless.run({
      agent: { provider: "agy", model: DEFAULT_MODEL_ID },
      prompt: "hello"
    });

    expect(JSON.parse(output)).toEqual([
      "--dangerously-skip-permissions",
      "--mode",
      "accept-edits",
      "--print-timeout",
      "2m",
      "--print",
      "hello"
    ]);
  });

  it("runs grok with model and reasoning effort mapped to effort args", async () => {
    const bin = await writeExecutable(
      "fake-grok-args.mjs",
      [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify(process.argv.slice(2)));"
      ].join("\n")
    );
    const headless = createHeadlessCore({ env: { ...process.env, GROK_BIN: bin } });

    const output = await headless.run({
      agent: { provider: "grok", model: "grok-4.5", reasoningEffort: "medium" },
      prompt: "hello"
    });

    expect(JSON.parse(output)).toEqual([
      "--model",
      "grok-4.5",
      "--effort",
      "medium",
      "--output-format",
      "plain",
      "--single",
      "hello"
    ]);
  });

  it("omits grok effort args when the default reasoning effort is selected", async () => {
    const bin = await writeExecutable(
      "fake-grok-default-reasoning-effort.mjs",
      [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify(process.argv.slice(2)));"
      ].join("\n")
    );
    const headless = createHeadlessCore({ env: { ...process.env, GROK_BIN: bin } });

    const output = await headless.run({
      agent: { provider: "grok", model: DEFAULT_MODEL_ID, reasoningEffort: DEFAULT_REASONING_EFFORT_ID },
      prompt: "hello"
    });

    expect(JSON.parse(output)).toEqual(["--output-format", "plain", "--single", "hello"]);
  });

  it("emits progress events and returns stdout", async () => {
    const bin = await writeExecutable(
      "fake-grok.mjs",
      [
        "#!/usr/bin/env node",
        "process.stdout.write('ok');"
      ].join("\n")
    );
    const events: ProgressEvent[] = [];
    const headless = createHeadlessCore({ env: { ...process.env, GROK_BIN: bin } });

    const output = await headless.run({
      agent: { provider: "grok", model: "grok-build" },
      prompt: "hello",
      onProgress(event) {
        events.push(event);
      }
    });

    expect(output).toBe("ok");
    expect(events.map((event) => event.state)).toContain("starting");
    expect(events.map((event) => event.state)).toContain("running");
    expect(events.map((event) => event.state)).toContain("completed");
  });

  it("can rerun through fallback", async () => {
    const codexBin = await writeExecutable(
      "fake-codex-fail.mjs",
      [
        "#!/usr/bin/env node",
        "process.stderr.write('rate limit');",
        "process.exit(1);"
      ].join("\n")
    );
    const grokBin = await writeExecutable(
      "fake-grok-success.mjs",
      [
        "#!/usr/bin/env node",
        "process.stdout.write('fallback ok');"
      ].join("\n")
    );
    const headless = createHeadlessCore({
      env: { ...process.env, CODEX_BIN: codexBin, GROK_BIN: grokBin }
    });

    const output = await headless.run({
      agent: { provider: "codex", model: "gpt-5.5" },
      prompt: "hello",
      onFallback({ error, prompt }) {
        expect(error.kind).toBe("rate_limit");
        return {
          type: "rerun",
          agent: { provider: "grok", model: "grok-build" },
          prompt
        };
      }
    });

    expect(output).toBe("fallback ok");
  });
});

async function writeExecutable(name: string, source: string): Promise<string> {
  const filePath = path.join(tmpDir, name);
  await writeFile(filePath, `${source}\n`);
  await chmod(filePath, 0o755);
  return filePath;
}
