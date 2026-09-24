import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createHeadlessCore,
  DEFAULT_MODEL_ID,
  DEFAULT_REASONING_EFFORT_ID,
  EffortError,
  type ProgressEvent
} from "../src/index.js";

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

  it("fails agy when headless mode auto-denies a command permission with empty stdout", async () => {
    const bin = await writeExecutable(
      "fake-agy-permission-denied.mjs",
      [
        "#!/usr/bin/env node",
        "process.stderr.write('jetski: no output produced — a tool required the \"command\" permission that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json (e.g. command(<target>)). Alternatively, re-run with --dangerously-skip-permissions to auto-approve all tools.');",
        "process.exit(0);"
      ].join("\n")
    );
    const headless = createHeadlessCore({ env: { ...process.env, AGY_BIN: bin } });

    await expect(
      headless.run({
        agent: { provider: "agy", model: "gemini-3.5-flash" },
        prompt: "hello"
      })
    ).rejects.toThrow(/command" permission that headless mode cannot prompt/);
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

  it("runs devin in print mode with workspace trust skipped and read-only permissions", async () => {
    const bin = await writeExecutable(
      "fake-devin.mjs",
      [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify(process.argv.slice(2)));"
      ].join("\n")
    );
    const headless = createHeadlessCore({ env: { ...process.env, DEVIN_BIN: bin } });

    const output = await headless.run({
      agent: { provider: "devin", model: "claude-opus-5-high" },
      prompt: "hello"
    });

    expect(JSON.parse(output)).toEqual([
      "--print",
      "--respect-workspace-trust",
      "false",
      "--permission-mode",
      "auto",
      "--model",
      "claude-opus-5-high",
      "--",
      "hello"
    ]);
  });

  it("folds devin reasoning effort into the model uid suffix", async () => {
    const bin = await writeExecutable(
      "fake-devin-effort.mjs",
      [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify(process.argv.slice(2)));"
      ].join("\n")
    );
    const headless = createHeadlessCore({ env: { ...process.env, DEVIN_BIN: bin } });

    const output = await headless.run({
      agent: { provider: "devin", model: "claude-opus-5", reasoningEffort: "high" },
      prompt: "hello"
    });

    expect(JSON.parse(output)).toEqual([
      "--print",
      "--respect-workspace-trust",
      "false",
      "--permission-mode",
      "auto",
      "--model",
      "claude-opus-5-high",
      "--",
      "hello"
    ]);
  });

  it("replaces an existing devin model level suffix with the selected effort", async () => {
    const bin = await writeExecutable(
      "fake-devin-effort-replace.mjs",
      [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify(process.argv.slice(2)));"
      ].join("\n")
    );
    const headless = createHeadlessCore({ env: { ...process.env, DEVIN_BIN: bin } });

    const output = await headless.run({
      agent: { provider: "devin", model: "claude-opus-5-medium-fast", reasoningEffort: "xhigh" },
      prompt: "hello"
    });

    expect(JSON.parse(output)).toEqual([
      "--print",
      "--respect-workspace-trust",
      "false",
      "--permission-mode",
      "auto",
      "--model",
      "claude-opus-5-xhigh-fast",
      "--",
      "hello"
    ]);
  });

  it("converts dotted devin family slugs when folding the effort", async () => {
    const bin = await writeExecutable(
      "fake-devin-effort-dotted.mjs",
      [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify(process.argv.slice(2)));"
      ].join("\n")
    );
    const headless = createHeadlessCore({ env: { ...process.env, DEVIN_BIN: bin } });

    const output = await headless.run({
      agent: { provider: "devin", model: "gpt-5.6-sol", reasoningEffort: "low" },
      prompt: "hello"
    });

    expect(JSON.parse(output)).toEqual([
      "--print",
      "--respect-workspace-trust",
      "false",
      "--permission-mode",
      "auto",
      "--model",
      "gpt-5-6-sol-low",
      "--",
      "hello"
    ]);
  });

  it("rejects devin reasoning effort when the default model is selected", async () => {
    const bin = await writeExecutable(
      "fake-devin-effort-default.mjs",
      [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify(process.argv.slice(2)));"
      ].join("\n")
    );
    const headless = createHeadlessCore({ env: { ...process.env, DEVIN_BIN: bin } });

    await expect(
      headless.run({
        agent: { provider: "devin", model: DEFAULT_MODEL_ID, reasoningEffort: "high" },
        prompt: "hello"
      })
    ).rejects.toThrow(/devin reasoningEffort requires an explicit agent\.model/);
  });

  it("omits devin model args when the default model is selected", async () => {
    const bin = await writeExecutable(
      "fake-devin-default.mjs",
      [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify(process.argv.slice(2)));"
      ].join("\n")
    );
    const headless = createHeadlessCore({ env: { ...process.env, DEVIN_BIN: bin } });

    const output = await headless.run({
      agent: { provider: "devin", model: DEFAULT_MODEL_ID },
      prompt: "hello"
    });

    expect(JSON.parse(output)).toEqual([
      "--print",
      "--respect-workspace-trust",
      "false",
      "--permission-mode",
      "auto",
      "--",
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

  describe("reasoning effort", () => {
    // A codex CLI that answers `debug models` with a capability catalog and
    // echoes argv otherwise.
    async function fakeCodexWithCatalog(): Promise<string> {
      return writeExecutable(
        "fake-codex-catalog.mjs",
        [
          "#!/usr/bin/env node",
          "const args = process.argv.slice(2);",
          'if (args[0] === "debug" && args[1] === "models") {',
          "  process.stdout.write(JSON.stringify({ models: [",
          '    { slug: "gpt-5.5", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }] },',
          '    { slug: "gpt-6", supported_reasoning_levels: [{ effort: "none" }, { effort: "minimal" }, { effort: "low" }, { effort: "max" }] }',
          "  ] }));",
          "} else {",
          "  process.stdout.write(JSON.stringify(args));",
          "}"
        ].join("\n")
      );
    }

    it("maps codex none to model_reasoning_effort on a model that supports it", async () => {
      const bin = await fakeCodexWithCatalog();
      const headless = createHeadlessCore({ env: { ...process.env, CODEX_BIN: bin } });

      const output = await headless.run({
        agent: { provider: "codex", model: "gpt-6", reasoningEffort: "none" },
        prompt: "hello"
      });

      expect(JSON.parse(output)).toContain('model_reasoning_effort="none"');
    });

    it("maps codex minimal to model_reasoning_effort on a model that supports it", async () => {
      const bin = await fakeCodexWithCatalog();
      const headless = createHeadlessCore({ env: { ...process.env, CODEX_BIN: bin } });

      const output = await headless.run({
        agent: { provider: "codex", model: "gpt-6", reasoningEffort: "minimal" },
        prompt: "hello"
      });

      expect(JSON.parse(output)).toContain('model_reasoning_effort="minimal"');
    });

    it("rejects codex none on a model without it, listing supported efforts", async () => {
      const bin = await fakeCodexWithCatalog();
      const headless = createHeadlessCore({ env: { ...process.env, CODEX_BIN: bin } });

      const failure = await headless
        .run({
          agent: { provider: "codex", model: "gpt-5.5", reasoningEffort: "none" },
          prompt: "hello"
        })
        .catch((cause) => cause);

      expect(failure).toBeInstanceOf(EffortError);
      expect(failure.code).toBe("UNSUPPORTED_EFFORT");
      expect(failure.message).toContain('does not support reasoning effort "none"');
      expect(failure.message).toContain("low, medium, high, xhigh");
      expect(failure.supportedEfforts).toEqual(["low", "medium", "high", "xhigh"]);
    });

    it("rejects an invalid effort string before contacting the provider", async () => {
      const bin = await writeExecutable(
        "fake-codex-invalid-effort.mjs",
        ["#!/usr/bin/env node", "process.stdout.write(JSON.stringify(process.argv.slice(2)));"].join("\n")
      );
      const headless = createHeadlessCore({ env: { ...process.env, CODEX_BIN: bin } });

      const failure = await headless
        .run({
          agent: { provider: "codex", model: "gpt-5.5", reasoningEffort: "banana" },
          prompt: "hello"
        })
        .catch((cause) => cause);

      expect(failure).toBeInstanceOf(EffortError);
      expect(failure.code).toBe("INVALID_EFFORT");
      expect(failure.message).toContain('Unknown reasoning effort "banana"');
    });

    it("treats omitted effort and explicit default identically", async () => {
      const bin = await writeExecutable(
        "fake-codex-default-equivalence.mjs",
        ["#!/usr/bin/env node", "process.stdout.write(JSON.stringify(process.argv.slice(2)));"].join("\n")
      );
      const headless = createHeadlessCore({ env: { ...process.env, CODEX_BIN: bin } });

      const omitted = JSON.parse(
        await headless.run({ agent: { provider: "codex", model: "gpt-5.5" }, prompt: "hello" })
      ) as string[];
      const explicit = JSON.parse(
        await headless.run({
          agent: { provider: "codex", model: "gpt-5.5", reasoningEffort: "default" },
          prompt: "hello"
        })
      ) as string[];

      expect(explicit).toEqual(omitted);
      expect(omitted.join(" ")).not.toContain("model_reasoning_effort");
    });

    // An agy CLI that answers `models` with an id<TAB>name listing.
    async function fakeAgyWithCatalog(): Promise<string> {
      return writeExecutable(
        "fake-agy-catalog.mjs",
        [
          "#!/usr/bin/env node",
          "const args = process.argv.slice(2);",
          'if (args[0] === "models") {',
          "  process.stdout.write([",
          '    "Fetching available models...",',
          '    "gemini-3-8-flash-minimal\\tGemini 3.8 Flash (Minimal)",',
          '    "gemini-3-8-flash-low\\tGemini 3.8 Flash (Low)",',
          '    "gemini-3-8-flash-medium\\tGemini 3.8 Flash (Medium)",',
          '    "gemini-3-8-flash-high\\tGemini 3.8 Flash (High)",',
          '    "gemini-2-5-flash-none\\tGemini 2.5 Flash (No Thinking)",',
          '    "gemini-2-5-flash-low\\tGemini 2.5 Flash (Low)",',
          '    "gemini-2-5-flash-medium\\tGemini 2.5 Flash (Medium)",',
          '    "gemini-2-5-flash-high\\tGemini 2.5 Flash (High)",',
          '    "gemini-2-5-pro-low\\tGemini 2.5 Pro (Low)",',
          '    "gemini-2-5-pro-medium\\tGemini 2.5 Pro (Medium)",',
          '    "gemini-2-5-pro-high\\tGemini 2.5 Pro (High)"',
          "  ].join(\"\\n\"));",
          "} else {",
          "  process.stdout.write(JSON.stringify(args));",
          "}"
        ].join("\n")
      );
    }

    it("maps agy minimal to the advertised minimal variant id", async () => {
      const bin = await fakeAgyWithCatalog();
      const headless = createHeadlessCore({ env: { ...process.env, AGY_BIN: bin } });

      const output = (JSON.parse(
        await headless.run({
          agent: { provider: "agy", model: "gemini-3-8-flash", reasoningEffort: "minimal" },
          prompt: "hello"
        })
      ) as string[]).join(" ");

      expect(output).toContain("--model gemini-3-8-flash-minimal");
      expect(output).not.toContain("--effort");
    });

    it("maps agy none to an advertised non-thinking variant only", async () => {
      const bin = await fakeAgyWithCatalog();
      const headless = createHeadlessCore({ env: { ...process.env, AGY_BIN: bin } });

      const output = (JSON.parse(
        await headless.run({
          agent: { provider: "agy", model: "gemini-2-5-flash", reasoningEffort: "none" },
          prompt: "hello"
        })
      ) as string[]).join(" ");

      expect(output).toContain("--model gemini-2-5-flash-none");
      expect(output).not.toContain("--effort");
    });

    it("rejects agy none when the model family cannot disable thinking", async () => {
      const bin = await fakeAgyWithCatalog();
      const headless = createHeadlessCore({ env: { ...process.env, AGY_BIN: bin } });

      const failure = await headless
        .run({
          agent: { provider: "agy", model: "gemini-2-5-pro", reasoningEffort: "none" },
          prompt: "hello"
        })
        .catch((cause) => cause);

      expect(failure).toBeInstanceOf(EffortError);
      expect(failure.code).toBe("UNSUPPORTED_EFFORT");
      expect(failure.supportedEfforts).not.toContain("none");
      expect(failure.supportedEfforts).toEqual(expect.arrayContaining(["low", "medium", "high"]));
    });

    it("rejects agy none for gemini-3.x without a non-thinking variant", async () => {
      const bin = await fakeAgyWithCatalog();
      const headless = createHeadlessCore({ env: { ...process.env, AGY_BIN: bin } });

      const failure = await headless
        .run({
          agent: { provider: "agy", model: "gemini-3-8-flash", reasoningEffort: "none" },
          prompt: "hello"
        })
        .catch((cause) => cause);

      expect(failure).toBeInstanceOf(EffortError);
      expect(failure.code).toBe("UNSUPPORTED_EFFORT");
      expect(failure.message).not.toContain("gemini-3-8-flash-none");
    });

    it("prefers the advertised level variant over the agy --effort flag", async () => {
      const bin = await fakeAgyWithCatalog();
      const headless = createHeadlessCore({ env: { ...process.env, AGY_BIN: bin } });

      const output = (JSON.parse(
        await headless.run({
          agent: { provider: "agy", model: "gemini-2-5-pro", reasoningEffort: "low" },
          prompt: "hello"
        })
      ) as string[]).join(" ");

      // The gemini-2-5-pro-low variant carries the level.
      expect(output).toContain("--model gemini-2-5-pro-low");
      expect(output).not.toContain("--effort");
    });

    it("uses the agy --effort flag when the model has no level variants", async () => {
      const bin = await fakeAgyWithCatalog();
      const headless = createHeadlessCore({ env: { ...process.env, AGY_BIN: bin } });

      const output = (JSON.parse(
        await headless.run({
          agent: { provider: "agy", model: "m-plain", reasoningEffort: "low" },
          prompt: "hello"
        })
      ) as string[]).join(" ");

      expect(output).toContain("--model m-plain");
      expect(output).toContain("--effort low");
    });

    // A devin CLI that answers `models list --format json` with variants.
    async function fakeDevinWithCatalog(): Promise<string> {
      return writeExecutable(
        "fake-devin-catalog.mjs",
        [
          "#!/usr/bin/env node",
          "const args = process.argv.slice(2);",
          'if (args[0] === "models" && args[1] === "list") {',
          "  process.stdout.write(JSON.stringify({ families: [",
          '    { slug: "swe-2", variants: [{ model_uid: "swe-2-high" }] },',
          '    { slug: "claude-opus-5", variants: [{ model_uid: "claude-opus-5-medium" }, { model_uid: "claude-opus-5-high" }] },',
          '    { slug: "gpt-5.4", variants: [{ model_uid: "gpt-5-4-low" }, { model_uid: "gpt-5-4-none" }] }',
          "  ] }));",
          "} else {",
          "  process.stdout.write(JSON.stringify(args));",
          "}"
        ].join("\n")
      );
    }

    it("maps devin none to an advertised non-reasoning variant uid", async () => {
      const bin = await fakeDevinWithCatalog();
      const headless = createHeadlessCore({ env: { ...process.env, DEVIN_BIN: bin } });

      const output = (JSON.parse(
        await headless.run({
          agent: { provider: "devin", model: "gpt-5.4", reasoningEffort: "none" },
          prompt: "hello"
        })
      ) as string[]).join(" ");

      expect(output).toContain("--model gpt-5-4-none");
    });

    it("rejects devin none when the family has no non-reasoning variant", async () => {
      const bin = await fakeDevinWithCatalog();
      const headless = createHeadlessCore({ env: { ...process.env, DEVIN_BIN: bin } });

      const failure = await headless
        .run({
          agent: { provider: "devin", model: "swe-2", reasoningEffort: "none" },
          prompt: "hello"
        })
        .catch((cause) => cause);

      expect(failure).toBeInstanceOf(EffortError);
      expect(failure.code).toBe("UNSUPPORTED_EFFORT");
      expect(failure.message).not.toContain("swe-2-none");
    });

    it("rejects a devin level the family does not advertise instead of converting", async () => {
      const bin = await fakeDevinWithCatalog();
      const headless = createHeadlessCore({ env: { ...process.env, DEVIN_BIN: bin } });

      const failure = await headless
        .run({
          agent: { provider: "devin", model: "swe-2", reasoningEffort: "low" },
          prompt: "hello"
        })
        .catch((cause) => cause);

      expect(failure).toBeInstanceOf(EffortError);
      expect(failure.code).toBe("UNSUPPORTED_EFFORT");
      expect(failure.supportedEfforts).toContain("high");
    });
  });
});

async function writeExecutable(name: string, source: string): Promise<string> {
  const filePath = path.join(tmpDir, name);
  await writeFile(filePath, `${source}\n`);
  await chmod(filePath, 0o755);
  return filePath;
}
