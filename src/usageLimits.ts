import type { SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import { fetchClaudeUsage } from "./claudeSdk.js";
import { CodexAppServerRuntime, codexAppServerRuntimeKey } from "./codexAppServer.js";
import { isAgentId } from "./config.js";
import { CONTROL_REQUEST_TIMEOUT_MS, type SessionContext } from "./runtimeManager.js";
import {
  AGENT_IDS,
  type AgentId,
  type AgentUsageLimits,
  type UsagePeriod,
  type UsageWindow
} from "./types.js";

type CodexRateLimitWindow = {
  usedPercent?: number | null;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
};

type CodexRateLimitSnapshot = {
  limitId?: string | null;
  limitName?: string | null;
  primary?: CodexRateLimitWindow | null;
  secondary?: CodexRateLimitWindow | null;
  planType?: string | null;
};

export type CodexRateLimitsResponse = {
  rateLimits?: CodexRateLimitSnapshot | null;
  rateLimitsByLimitId?: Record<string, CodexRateLimitSnapshot | null | undefined> | null;
};

type ClaudeRateLimits = NonNullable<SDKControlGetUsageResponse["rate_limits"]>;

const FIVE_HOUR_MINUTES = 5 * 60;
const DAY_MINUTES = 24 * 60;
const WEEK_MINUTES = 7 * DAY_MINUTES;

/** Claude per-window fields, in display order. Every one is a 7-day window except `five_hour`. */
const CLAUDE_WINDOWS: ReadonlyArray<{ key: keyof ClaudeRateLimits; label: string; scope?: string }> = [
  { key: "five_hour", label: "5-hour" },
  { key: "seven_day", label: "Weekly" },
  { key: "seven_day_opus", label: "Weekly (Opus)", scope: "opus" },
  { key: "seven_day_sonnet", label: "Weekly (Sonnet)", scope: "sonnet" },
  { key: "seven_day_oauth_apps", label: "Weekly (OAuth apps)", scope: "oauth_apps" }
];

const UNSUPPORTED_REASON: Partial<Record<AgentId, string>> = {
  agy: "agy does not expose plan usage limits",
  grok: "grok does not expose plan usage limits (`grok usage` only reports per-session token cost)",
  devin: "devin does not expose plan usage limits"
};

export async function getUsageLimits(ctx: SessionContext, agent: string): Promise<AgentUsageLimits> {
  if (!isAgentId(agent)) {
    throw new Error(`Unsupported provider: ${agent}`);
  }
  const fetchedAt = new Date().toISOString();
  const unsupported = UNSUPPORTED_REASON[agent];
  if (unsupported) {
    return { provider: agent, supported: false, available: false, plan: null, windows: [], error: unsupported, fetchedAt };
  }

  try {
    const limits =
      agent === "codex"
        ? codexUsageLimits(await withTimeout(fetchCodexRateLimits(ctx), "codex"))
        : claudeUsageLimits(await withTimeout(fetchClaudeUsage(ctx), "claude"));
    return { provider: agent, supported: true, fetchedAt, ...limits };
  } catch (cause) {
    return {
      provider: agent,
      supported: true,
      available: false,
      plan: null,
      windows: [],
      error: cause instanceof Error ? cause.message : String(cause),
      fetchedAt
    };
  }
}

export function getAllUsageLimits(ctx: SessionContext): Promise<AgentUsageLimits[]> {
  return Promise.all(AGENT_IDS.map((agent) => getUsageLimits(ctx, agent)));
}

async function fetchCodexRateLimits(ctx: SessionContext): Promise<CodexRateLimitsResponse> {
  // Shares the app-server process with open codex sessions; otherwise it is
  // started for this read and exits on release.
  const key = codexAppServerRuntimeKey(ctx.env);
  const runtime = await ctx.manager.acquire(key, () => CodexAppServerRuntime.start(ctx));
  try {
    return await runtime.request<CodexRateLimitsResponse>("account/rateLimits/read");
  } finally {
    ctx.manager.release(key, runtime);
  }
}

type ParsedLimits = Pick<AgentUsageLimits, "available" | "plan" | "windows" | "error">;

export function codexUsageLimits(response: CodexRateLimitsResponse): ParsedLimits {
  const snapshots = Object.values(response.rateLimitsByLimitId ?? {}).filter(
    (snapshot): snapshot is CodexRateLimitSnapshot => Boolean(snapshot)
  );
  if (snapshots.length === 0 && response.rateLimits) {
    snapshots.push(response.rateLimits);
  }

  const windows: UsageWindow[] = [];
  let plan: string | null = null;
  for (const snapshot of snapshots) {
    plan ??= snapshot.planType ?? null;
    const limitId = snapshot.limitId ?? "codex";
    const name = snapshot.limitName ?? (limitId === "codex" ? undefined : limitId);
    for (const slot of ["primary", "secondary"] as const) {
      const window = snapshot[slot];
      if (!window) {
        continue;
      }
      const minutes = window.windowDurationMins ?? null;
      const period = periodForMinutes(minutes);
      windows.push({
        id: `${limitId}:${slot}`,
        period,
        label: name ? `${periodLabel(period, minutes)} (${name})` : periodLabel(period, minutes),
        ...percentages(window.usedPercent),
        resetsAt: typeof window.resetsAt === "number" ? new Date(window.resetsAt * 1000).toISOString() : null,
        windowMinutes: minutes,
        ...(limitId === "codex" ? {} : { scope: limitId })
      });
    }
  }
  return { available: true, plan, windows };
}

export function claudeUsageLimits(response: SDKControlGetUsageResponse): ParsedLimits {
  const plan = response.subscription_type ?? null;
  const limits = response.rate_limits;
  if (!response.rate_limits_available || !limits) {
    return {
      available: false,
      plan,
      windows: [],
      error: "Plan usage limits are unavailable (API key, Bedrock/Vertex, or not logged in to claude.ai)"
    };
  }

  const windows: UsageWindow[] = [];
  for (const { key, label, scope } of CLAUDE_WINDOWS) {
    const window = limits[key] as { utilization: number | null; resets_at: string | null } | null | undefined;
    if (!window) {
      continue;
    }
    const minutes = key === "five_hour" ? FIVE_HOUR_MINUTES : WEEK_MINUTES;
    windows.push({
      id: key,
      period: periodForMinutes(minutes),
      label,
      ...percentages(window.utilization),
      resetsAt: window.resets_at,
      windowMinutes: minutes,
      ...(scope ? { scope } : {})
    });
  }
  for (const window of limits.model_scoped ?? []) {
    windows.push({
      id: `model:${window.display_name}`,
      period: "weekly",
      label: `Weekly (${window.display_name})`,
      ...percentages(window.utilization),
      resetsAt: window.resets_at,
      windowMinutes: WEEK_MINUTES,
      scope: window.display_name
    });
  }
  return { available: true, plan, windows };
}

export function periodForMinutes(minutes: number | null): UsagePeriod {
  switch (minutes) {
    case FIVE_HOUR_MINUTES:
      return "five_hour";
    case DAY_MINUTES:
      return "daily";
    case WEEK_MINUTES:
      return "weekly";
    default:
      // Calendar months are 28-31 days.
      return minutes !== null && minutes >= 28 * DAY_MINUTES && minutes <= 31 * DAY_MINUTES ? "monthly" : "other";
  }
}

function periodLabel(period: UsagePeriod, minutes: number | null): string {
  switch (period) {
    case "five_hour":
      return "5-hour";
    case "daily":
      return "Daily";
    case "weekly":
      return "Weekly";
    case "monthly":
      return "Monthly";
    default:
      return minutes === null ? "Usage" : `${minutes}-minute`;
  }
}

function percentages(used: number | null | undefined): Pick<UsageWindow, "usedPercent" | "remainingPercent"> {
  if (typeof used !== "number" || !Number.isFinite(used)) {
    return { usedPercent: null, remainingPercent: null };
  }
  return { usedPercent: used, remainingPercent: Math.min(100, Math.max(0, 100 - used)) };
}

function withTimeout<T>(promise: Promise<T>, provider: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out reading ${provider} usage limits after ${CONTROL_REQUEST_TIMEOUT_MS}ms`)),
      CONTROL_REQUEST_TIMEOUT_MS
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
