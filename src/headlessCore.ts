import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { AgyAcpRuntime, AgyAcpSession, agyAcpRuntimeKey } from "./agyAcp.js";
import { resolveAgyEffort } from "./agyModel.js";
import { ClaudeSdkSession } from "./claudeSdk.js";
import { ClaudeToolUseTracker, describeToolUse, resolveTools, type ResolvedTools } from "./claudeTools.js";
import { CliSession } from "./cliSession.js";
import {
  CodexAppServerRuntime,
  CodexAppServerSession,
  codexAppServerRuntimeKey
} from "./codexAppServer.js";
import { DevinAcpRuntime, DevinAcpSession, devinAcpRuntimeKey } from "./devinAcp.js";
import { devinModelWithEffort, resolveDevinModel } from "./devinModel.js";
import { GrokAcpRuntime, GrokAcpSession, grokAcpRuntimeKey } from "./grokAcp.js";
import { parseRequestedEffort, unsupportedEffort } from "./effort.js";
import { EffortError, ToolsError } from "./errors.js";
import { getAllUsageLimits, getUsageLimits } from "./usageLimits.js";
import { agyModelIds, codexModelEffortLevels, devinModelVariantUids } from "./modelCatalog.js";
import {
  RuntimeManager,
  resolveTransport,
  validateTransport,
  type SessionContext
} from "./runtimeManager.js";
import {
  AGENT_IDS,
  DEFAULT_MODEL_ID,
  type AgentSpec,
  type CreateSessionOptions,
  type EffortLevel,
  type FallbackResult,
  type HeadlessCore,
  type HeadlessCoreConfig,
  type HeadlessError,
  type HeadlessRunOptions,
  type HeadlessSession,
  type ProgressEvent,
  type ProgressSnapshot
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 120_000;

/** Effort levels each provider's own effort flag accepts. */
const CLAUDE_SUPPORTED_EFFORTS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
const GROK_SUPPORTED_EFFORTS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh"];

type CommandSpec = {
  command: string;
  args: string[];
  /** stdout is Claude Code `--output-format stream-json` (claude with tools enabled). */
  claudeStream?: boolean;
};

type RunFailure = {
  error: HeadlessError;
  stdout: string;
  stderr: string;
};

export function createHeadlessCore(config: HeadlessCoreConfig = {}): HeadlessCore {
  const manager = new RuntimeManager();
  const contextFor = (cwd?: string): SessionContext => ({
    cwd: cwd ?? config.cwd ?? process.cwd(),
    env: config.env ?? process.env,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    manager
  });

  return {
    async run(options) {
      return runWithFallback(contextFor(options.cwd), options);
    },
    async createSession(options) {
      return createSession(contextFor(options.cwd), options);
    },
    async getUsageLimits(options) {
      return getUsageLimits(contextFor(), options.agent);
    },
    async getAllUsageLimits() {
      return getAllUsageLimits(contextFor());
    },
    async shutdown() {
      await manager.shutdown();
    }
  };
}

async function createSession(ctx: SessionContext, options: CreateSessionOptions): Promise<HeadlessSession> {
  const agent = options.agent;
  if (!agent || !agent.provider?.trim()) {
    throw new Error("agent.provider is required");
  }
  if (!(AGENT_IDS as readonly string[]).includes(agent.provider)) {
    throw new Error(`Unsupported provider: ${agent.provider}`);
  }
  const transport = resolveTransport(agent);
  validateTransport(agent.provider, transport);
  resolveTools(agent);

  if (transport === "app-server") {
    const key = codexAppServerRuntimeKey(ctx.env);
    const runtime = await ctx.manager.acquire(key, () => CodexAppServerRuntime.start(ctx));
    return CodexAppServerSession.create(runtime, ctx, agent, () => ctx.manager.release(key, runtime));
  }

  if (transport === "sdk") {
    return ClaudeSdkSession.create(ctx, agent);
  }

  if (transport === "acp") {
    if (agent.provider === "agy") {
      const key = agyAcpRuntimeKey(ctx.env);
      const runtime = await ctx.manager.acquire(key, () => AgyAcpRuntime.start(ctx));
      return AgyAcpSession.create(runtime, ctx, agent, () => ctx.manager.release(key, runtime));
    }
    if (agent.provider === "grok") {
      const key = grokAcpRuntimeKey(ctx.env);
      const runtime = await ctx.manager.acquire(key, () => GrokAcpRuntime.start(ctx));
      return GrokAcpSession.create(runtime, ctx, agent, () => ctx.manager.release(key, runtime));
    }
    const key = devinAcpRuntimeKey(ctx.env);
    const runtime = await ctx.manager.acquire(key, () => DevinAcpRuntime.start(ctx));
    return DevinAcpSession.create(runtime, ctx, agent, () => ctx.manager.release(key, runtime));
  }

  return new CliSession(agent, (runOptions) => runOnce(ctx, runOptions));
}

async function runWithFallback(ctx: SessionContext, options: HeadlessRunOptions): Promise<string> {
  const runId = randomUUID();
  let prompt = options.prompt;
  let agent = options.agent;
  let fallbackUsed = false;

  for (;;) {
    try {
      return await runOnce(ctx, { ...options, agent, prompt });
    } catch (cause) {
      // Effort/tools validation failures are request errors, not provider run
      // failures: surface them typed and never route them through fallback.
      if (cause instanceof EffortError || cause instanceof ToolsError) {
        throw cause;
      }
      const failure = toRunFailure(cause);
      const progress = createProgressSnapshot(agent, failure);
      await emitProgress(options, {
        state: "failed",
        agent,
        error: failure.error,
        partialOutput: failure.stdout || failure.stderr
      });

      if (!options.onFallback || fallbackUsed) {
        throw new Error(failure.error.message, { cause });
      }

      fallbackUsed = true;
      await emitProgress(options, {
        state: "fallback",
        agent,
        error: failure.error,
        message: "Running fallback"
      });

      const result = await options.onFallback({
        runId,
        prompt,
        failedAgent: agent,
        error: failure.error,
        progress,
        log: () => undefined
      });

      if (result.type === "final") {
        return result.output;
      }
      if (result.type === "fail") {
        throw result.error ?? new Error(failure.error.message, { cause });
      }

      agent = result.agent;
      prompt = result.prompt ?? prompt;
    }
  }
}

async function runOnce(ctx: SessionContext, options: HeadlessRunOptions): Promise<string> {
  validateRunOptions(options);
  const timeoutMs = options.timeoutMs ?? ctx.timeoutMs;

  if (resolveTransport(options.agent) !== "cli") {
    return runPersistentOnce(ctx, options, timeoutMs);
  }

  const spec = await commandFor(options.agent, options.prompt, ctx.env, timeoutMs);
  if (spec.claudeStream) {
    return runClaudeStream(ctx, options, spec, timeoutMs);
  }
  const { command, args } = spec;
  await emitProgress(options, { state: "starting", agent: options.agent, message: `Starting ${options.agent.provider}` });
  const result = await runCommand(command, args, {
    cwd: ctx.cwd,
    env: ctx.env,
    signal: options.signal,
    timeoutMs,
    onStdout: (partialOutput) => emitProgress(options, { state: "running", agent: options.agent, partialOutput }),
    onStderr: (partialOutput) => emitProgress(options, { state: "running", agent: options.agent, partialOutput })
  });

  await emitProgress(options, {
    state: "completed",
    agent: options.agent,
    partialOutput: result.stdout || result.stderr
  });

  return (result.stdout || result.stderr).trim();
}

/**
 * Runs `claude --output-format stream-json`: text deltas of the top-level
 * agent stream as `running` partialOutput, tool calls as `toolUse` events,
 * and the `result` message becomes the final output.
 */
async function runClaudeStream(
  ctx: SessionContext,
  options: HeadlessRunOptions,
  spec: CommandSpec,
  timeoutMs: number
): Promise<string> {
  const agent = options.agent;
  const tracker = new ClaudeToolUseTracker();
  let buffer = "";
  let text = "";
  let result: Record<string, unknown> | undefined;
  let assistantError: string | undefined;

  const handleLine = async (line: string) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.type === "stream_event") {
      const event = message.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
      if (
        message.parent_tool_use_id == null &&
        event?.type === "content_block_delta" &&
        event.delta?.type === "text_delta" &&
        event.delta.text
      ) {
        text += event.delta.text;
        await emitProgress(options, { state: "running", agent, partialOutput: event.delta.text });
      }
      return;
    }
    if (message.type === "result") {
      result = message;
      return;
    }
    if (message.type === "assistant" && message.parent_tool_use_id == null && typeof message.error === "string") {
      assistantError = message.error;
    }
    for (const toolUse of tracker.events(message)) {
      await emitProgress(options, { state: "running", agent, toolUse, message: describeToolUse(toolUse) });
    }
  };

  // Lines are handled in order even though stdout chunks arrive faster than
  // async progress callbacks settle.
  let lines: Promise<void> = Promise.resolve();
  const onStdout = (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        lines = lines.then(() => handleLine(line)).catch(() => undefined);
      }
      newline = buffer.indexOf("\n");
    }
  };
  const flush = async () => {
    const rest = buffer.trim();
    buffer = "";
    if (rest) {
      lines = lines.then(() => handleLine(rest)).catch(() => undefined);
    }
    await lines;
  };
  const resultError = (): string | undefined => {
    if (!result || (result.subtype === "success" && result.is_error !== true)) {
      return undefined;
    }
    const errors = Array.isArray(result.errors) ? result.errors.join("\n") : "";
    const details = (typeof result.result === "string" && result.result) || errors || String(result.subtype);
    return `${assistantError ? `${assistantError}: ` : ""}${details || "claude run failed"}`;
  };

  await emitProgress(options, { state: "starting", agent, message: `Starting ${agent.provider}` });
  let stderr: string;
  try {
    ({ stderr } = await runCommand(spec.command, spec.args, {
      cwd: ctx.cwd,
      env: ctx.env,
      signal: options.signal,
      timeoutMs,
      onStdout,
      onStderr: () => undefined
    }));
  } catch (cause) {
    await flush();
    const failure = toRunFailure(cause);
    if (failure.error.kind === "agent_stopped") {
      // Timeout/abort keeps its own message and kind.
      throw createRunFailure(failure.error.message, text, failure.stderr, failure.error.kind);
    }
    // Prefer the result's error over raw stream-json stdout.
    const message =
      resultError() || failure.stderr.trim() || (failure.stdout ? "claude exited with an error" : failure.error.message);
    throw createRunFailure(message, text, failure.stderr, classifyError(message));
  }
  await flush();

  const message = resultError();
  if (message) {
    throw createRunFailure(message, text, stderr, classifyError(message));
  }
  if (!result) {
    const detail = stderr.trim() || "claude exited without a result";
    throw createRunFailure(detail, text, stderr, classifyError(detail));
  }
  const output = (typeof result.result === "string" && result.result ? result.result : text).trim();
  await emitProgress(options, { state: "completed", agent, partialOutput: output });
  return output;
}

/** A one-shot run over a persistent transport: open a session, run, release. */
async function runPersistentOnce(
  ctx: SessionContext,
  options: HeadlessRunOptions,
  timeoutMs: number
): Promise<string> {
  const session = await createSession(ctx, { agent: options.agent });
  try {
    return await session.run({
      prompt: options.prompt,
      signal: options.signal,
      timeoutMs,
      onProgress: options.onProgress
    });
  } finally {
    await session.close().catch(() => undefined);
  }
}

function validateRunOptions(options: HeadlessRunOptions): void {
  if (!options.prompt.trim()) {
    throw new Error("prompt is required");
  }
  if (!options.agent.provider.trim()) {
    throw new Error("agent.provider is required");
  }
  if (!(AGENT_IDS as readonly string[]).includes(options.agent.provider)) {
    throw new Error(`Unsupported provider: ${options.agent.provider}`);
  }
  const transport = resolveTransport(options.agent);
  validateTransport(options.agent.provider, transport);
  resolveTools(options.agent);
  const effort = parseRequestedEffort(options.agent.reasoningEffort);
  if (
    transport === "cli" &&
    options.agent.provider === "devin" &&
    effort &&
    (!options.agent.model || options.agent.model === DEFAULT_MODEL_ID)
  ) {
    throw new Error(
      'devin reasoningEffort requires an explicit agent.model (thinking levels are model variant suffixes, e.g. "claude-opus-5-high")'
    );
  }
}

/**
 * Headless runs are text-in/text-out by default, so the agent must not use
 * tools. Otherwise it may try to write a file and stop to ask for permission
 * instead of printing the answer. Mirrors the codex read-only sandbox.
 */
function claudeNoToolArgs(): string[] {
  return ["--output-format", "text", "--tools", ""];
}

/**
 * Opt-in tools. stream-json streams text deltas and tool calls (text output
 * prints nothing until the end). Anything not allowed is denied instead of
 * prompting, because a headless run has no approval surface.
 */
function claudeToolArgs(tools: ResolvedTools): string[] {
  return [
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--tools",
    tools.allow.join(","),
    "--permission-mode",
    tools.permissionMode,
    // Without this, --print waits forever on calls the mode would prompt for
    // (e.g. a non-edit Bash command under acceptEdits).
    "--permission-prompts",
    "none",
    ...(tools.allowedRules.length ? ["--allowedTools", ...tools.allowedRules] : [])
  ];
}

/** Format milliseconds as an Agy --print-timeout duration (e.g. 2m, 5m0s, 90s). */
function formatAgyPrintTimeout(timeoutMs: number): string {
  const totalSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) {
    return `${seconds}s`;
  }
  if (seconds === 0) {
    return `${minutes}m`;
  }
  return `${minutes}m${seconds}s`;
}

async function commandFor(
  agent: AgentSpec,
  prompt: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<CommandSpec> {
  const provider = agent.provider;
  const modelId = agent.model && agent.model !== DEFAULT_MODEL_ID ? agent.model : undefined;
  const modelArgs = modelId ? ["--model", modelId] : [];
  const effort = parseRequestedEffort(agent.reasoningEffort);

  if (provider === "codex") {
    let codexEffort: string | undefined;
    if (effort) {
      // `codex debug models` advertises per-model supported levels. When the
      // selected model's capabilities are known, enforce them before spawning
      // the run; otherwise the provider remains the source of truth.
      const levels = modelId ? (await codexModelEffortLevels(env))?.get(modelId) : undefined;
      if (levels && !levels.includes(effort)) {
        throw unsupportedEffort("codex", modelId, effort, levels);
      }
      codexEffort = effort;
    }
    return {
      command: env.CODEX_BIN || "codex",
      args: [
        "exec",
        ...modelArgs,
        "--config",
        'approval_policy="never"',
        ...(codexEffort ? ["--config", `model_reasoning_effort="${codexEffort}"`] : []),
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--color",
        "never",
        prompt
      ]
    };
  }

  if (provider === "claude") {
    if (effort && !CLAUDE_SUPPORTED_EFFORTS.includes(effort)) {
      throw unsupportedEffort("claude", modelId, effort, CLAUDE_SUPPORTED_EFFORTS);
    }
    const tools = resolveTools(agent);
    return {
      command: env.CLAUDE_BIN || "claude",
      args: [
        "--print",
        ...(tools ? claudeToolArgs(tools) : claudeNoToolArgs()),
        ...modelArgs,
        ...(effort ? ["--effort", effort] : []),
        // `--tools`/`--allowedTools` are variadic and would swallow the prompt.
        "--",
        prompt
      ],
      claudeStream: tools !== undefined
    };
  }

  if (provider === "agy") {
    const resolved = effort ? resolveAgyEffort(modelId, effort, await agyModelIds(env)) : { model: modelId };
    return {
      command: env.AGY_BIN || "agy",
      args: [
        ...(resolved.model ? ["--model", resolved.model] : []),
        // Non-interactive --print cannot answer tool permission prompts.
        // Auto-approve so agents can use tools that write files (e.g. image generation).
        "--dangerously-skip-permissions",
        // Accept file edits without interactive confirmation.
        "--mode",
        "accept-edits",
        // Keep Agy's own wait aligned with this run's timeout.
        "--print-timeout",
        formatAgyPrintTimeout(timeoutMs),
        ...(resolved.flagEffort ? ["--effort", resolved.flagEffort] : []),
        "--print",
        prompt
      ]
    };
  }

  if (provider === "devin") {
    let devinModel = modelId;
    if (modelId && effort) {
      const uids = await devinModelVariantUids(env);
      if (uids) {
        // The variant catalog is known: the requested effort must map to an
        // advertised variant (or a non-thinking variant for "none") — never
        // a mechanical suffix or a silent level change.
        devinModel = resolveDevinModel(modelId, effort, uids, []).modelUid;
      } else {
        // Without the catalog only a verified variant could carry "none", so
        // it is always unsupported here; other levels degrade to the
        // mechanical fold the provider validates itself.
        if (effort === "none") {
          throw unsupportedEffort("devin", modelId, effort, []);
        }
        devinModel = devinModelWithEffort(modelId, effort);
      }
    }
    return {
      command: env.DEVIN_BIN || "devin",
      args: [
        "--print",
        // Non-interactive runs cannot answer the workspace trust prompt and
        // would fail in an untrusted directory.
        "--respect-workspace-trust",
        "false",
        // Keep the default posture explicit: auto-approves read-only tools
        // only, so a headless run can inspect files but not change them.
        // Mirrors the codex read-only sandbox and claude's disabled tools.
        "--permission-mode",
        "auto",
        ...(devinModel ? ["--model", devinModel] : []),
        "--",
        prompt
      ]
    };
  }

  if (effort && !GROK_SUPPORTED_EFFORTS.includes(effort)) {
    throw unsupportedEffort("grok", modelId, effort, GROK_SUPPORTED_EFFORTS);
  }
  return {
    command: env.GROK_BIN || "grok",
    args: [
      ...modelArgs,
      ...(effort ? ["--effort", effort] : []),
      "--output-format",
      "plain",
      "--single",
      prompt
    ]
  };
}

function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    signal?: AbortSignal;
    onStdout: (chunk: string) => void | Promise<void>;
    onStderr: (chunk: string) => void | Promise<void>;
  }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(createRunFailure("Command aborted before start", "", "", "agent_stopped"));
      return;
    }

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let settled = false;
    let stdout = "";
    let stderr = "";

    const finishReject = (failure: RunFailure) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(failure);
    };

    const finishResolve = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    };

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finishReject(createRunFailure(`Agent command timed out: ${command}`, stdout, stderr, "agent_stopped"));
    }, options.timeoutMs);

    const abort = () => {
      child.kill("SIGTERM");
      finishReject(createRunFailure(`Agent command aborted: ${command}`, stdout, stderr, "agent_stopped"));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
    };

    options.signal?.addEventListener("abort", abort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      void options.onStdout(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      void options.onStderr(chunk);
    });
    child.on("error", (error) => {
      finishReject(createRunFailure(error.message, stdout, stderr, classifyError(error.message)));
    });
    child.on("close", (code) => {
      if (settled) return;
      if (code === 0) {
        const permissionDenial = headlessPermissionDenialMessage(stdout, stderr);
        if (permissionDenial) {
          finishReject(createRunFailure(permissionDenial, stdout, stderr, classifyError(permissionDenial)));
          return;
        }
        finishResolve();
        return;
      }

      const message = (stderr || stdout || `${command} exited with ${code}`).trim();
      finishReject(createRunFailure(message, stdout, stderr, classifyError(message)));
    });
  });
}

function createRunFailure(
  message: string,
  stdout: string,
  stderr: string,
  kind: HeadlessError["kind"] = "unknown"
): RunFailure {
  return {
    error: { kind, message },
    stdout,
    stderr
  };
}

function toRunFailure(cause: unknown): RunFailure {
  if (isRunFailure(cause)) {
    return cause;
  }
  if (cause instanceof Error) {
    return createRunFailure(cause.message, "", "", classifyError(cause.message));
  }
  return createRunFailure(String(cause), "", "");
}

function isRunFailure(value: unknown): value is RunFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof (value as { error?: unknown }).error === "object"
  );
}

function classifyError(message: string): HeadlessError["kind"] {
  const normalized = message.toLowerCase();
  if (normalized.includes("rate limit") || normalized.includes("429")) {
    return "rate_limit";
  }
  if (
    normalized.includes("network") ||
    normalized.includes("enotfound") ||
    normalized.includes("econnrefused") ||
    normalized.includes("etimedout")
  ) {
    return "network";
  }
  return "unknown";
}

/**
 * Agy/jetski soft-denies tools in headless mode: it prints a notice to stderr,
 * exits 0, and leaves stdout empty. Treat that as a failed run instead of
 * returning the diagnostic as the agent answer.
 */
function headlessPermissionDenialMessage(stdout: string, stderr: string): string | undefined {
  if (stdout.trim()) {
    return undefined;
  }

  const message = stderr.trim();
  if (!message) {
    return undefined;
  }

  const normalized = message.toLowerCase();
  if (
    normalized.includes("headless mode cannot prompt") ||
    (normalized.includes("no output produced") && normalized.includes("dangerously-skip-permissions"))
  ) {
    return message;
  }

  return undefined;
}

function createProgressSnapshot(agent: AgentSpec, failure: RunFailure): ProgressSnapshot {
  return {
    state: "failed",
    agent,
    partialOutput: failure.stdout || failure.stderr,
    lastMessage: failure.error.message
  };
}

async function emitProgress(options: HeadlessRunOptions, event: ProgressEvent): Promise<void> {
  await options.onProgress?.(event);
}
