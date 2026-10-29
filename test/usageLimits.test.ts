import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHeadlessCore } from "../src/index.js";
import { claudeUsageLimits, codexUsageLimits, periodForMinutes } from "../src/usageLimits.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "headless-core-usage-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { force: true, recursive: true });
});

async function installFixture(name: string): Promise<string> {
  const source = await readFile(path.join(FIXTURES, name), "utf8");
  const filePath = path.join(tmpDir, name);
  await writeFile(filePath, source);
  await chmod(filePath, 0o755);
  return filePath;
}

describe("periodForMinutes", () => {
  it("maps provider window durations to periods", () => {
    expect(periodForMinutes(300)).toBe("five_hour");
    expect(periodForMinutes(1440)).toBe("daily");
    expect(periodForMinutes(10080)).toBe("weekly");
    expect(periodForMinutes(43200)).toBe("monthly");
    expect(periodForMinutes(60)).toBe("other");
    expect(periodForMinutes(null)).toBe("other");
  });
});

describe("codexUsageLimits", () => {
  it("turns every bucket's primary/secondary window into a usage window", () => {
    const limits = codexUsageLimits({
      rateLimits: null,
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          primary: { usedPercent: 3, windowDurationMins: 43200, resetsAt: 1794865807 },
          secondary: null,
          planType: "free"
        },
        codex_other: {
          limitId: "codex_other",
          limitName: "GPT-5.5",
          primary: { usedPercent: 120, windowDurationMins: 10080, resetsAt: null }
        }
      }
    });

    expect(limits).toEqual({
      available: true,
      plan: "free",
      windows: [
        {
          id: "codex:primary",
          period: "monthly",
          label: "Monthly",
          usedPercent: 3,
          remainingPercent: 97,
          resetsAt: new Date(1794865807 * 1000).toISOString(),
          windowMinutes: 43200
        },
        {
          id: "codex_other:primary",
          period: "weekly",
          label: "Weekly (GPT-5.5)",
          usedPercent: 120,
          remainingPercent: 0,
          resetsAt: null,
          windowMinutes: 10080,
          scope: "codex_other"
        }
      ]
    });
  });

  it("falls back to the single-bucket view", () => {
    const limits = codexUsageLimits({
      rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: null } }
    });
    expect(limits.windows.map((window) => [window.id, window.period])).toEqual([["codex:primary", "five_hour"]]);
  });
});

describe("claudeUsageLimits", () => {
  it("reads the 5-hour, weekly and model-scoped windows", () => {
    const limits = claudeUsageLimits({
      subscription_type: "max",
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 12, resets_at: "2026-10-29T12:20:00Z" },
        seven_day: { utilization: 39, resets_at: "2026-11-02T14:00:00Z" },
        seven_day_opus: null,
        seven_day_sonnet: { utilization: null, resets_at: null },
        model_scoped: [{ display_name: "Fable", utilization: 50, resets_at: "2026-11-02T14:00:00Z" }]
      }
    } as unknown as SDKControlGetUsageResponse);

    expect(limits.available).toBe(true);
    expect(limits.plan).toBe("max");
    expect(limits.windows).toEqual([
      {
        id: "five_hour",
        period: "five_hour",
        label: "5-hour",
        usedPercent: 12,
        remainingPercent: 88,
        resetsAt: "2026-10-29T12:20:00Z",
        windowMinutes: 300
      },
      {
        id: "seven_day",
        period: "weekly",
        label: "Weekly",
        usedPercent: 39,
        remainingPercent: 61,
        resetsAt: "2026-11-02T14:00:00Z",
        windowMinutes: 10080
      },
      {
        id: "seven_day_sonnet",
        period: "weekly",
        label: "Weekly (Sonnet)",
        usedPercent: null,
        remainingPercent: null,
        resetsAt: null,
        windowMinutes: 10080,
        scope: "sonnet"
      },
      {
        id: "model:Fable",
        period: "weekly",
        label: "Weekly (Fable)",
        usedPercent: 50,
        remainingPercent: 50,
        resetsAt: "2026-11-02T14:00:00Z",
        windowMinutes: 10080,
        scope: "Fable"
      }
    ]);
  });

  it("reports unavailable limits for API key sessions", () => {
    const limits = claudeUsageLimits({
      subscription_type: null,
      rate_limits_available: false,
      rate_limits: null
    } as unknown as SDKControlGetUsageResponse);
    expect(limits).toMatchObject({ available: false, plan: null, windows: [] });
    expect(limits.error).toMatch(/unavailable/);
  });
});

describe("HeadlessCore usage limits", () => {
  it("reads codex rate limits from the app-server", async () => {
    const bin = await installFixture("fake-codex-app-server.mjs");
    const headless = createHeadlessCore({ env: { ...process.env, CODEX_BIN: bin } });

    const limits = await headless.getUsageLimits({ agent: "codex" });
    expect(limits).toMatchObject({ provider: "codex", supported: true, available: true, plan: "plus" });
    expect(limits.windows.map((window) => [window.period, window.remainingPercent])).toEqual([
      ["five_hour", 75],
      ["weekly", 40]
    ]);
    await headless.shutdown();
  });

  it("reports a failed fetch without throwing", async () => {
    const headless = createHeadlessCore({
      env: { ...process.env, CODEX_BIN: path.join(tmpDir, "missing-codex") }
    });
    const limits = await headless.getUsageLimits({ agent: "codex" });
    expect(limits).toMatchObject({ provider: "codex", supported: true, available: false, windows: [] });
    expect(limits.error).toBeTruthy();
  });

  it("marks providers without plan usage as unsupported", async () => {
    const headless = createHeadlessCore();
    for (const agent of ["agy", "grok", "devin"]) {
      const limits = await headless.getUsageLimits({ agent });
      expect(limits).toMatchObject({ provider: agent, supported: false, available: false, windows: [] });
    }
  });

  it("rejects unknown providers", async () => {
    const headless = createHeadlessCore();
    await expect(headless.getUsageLimits({ agent: "nope" })).rejects.toThrow(/Unsupported provider/);
  });
});
