import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  AGENT_IDS,
  DEFAULT_MODEL_ID,
  DEFAULT_REASONING_EFFORT_ID,
  type AgentSpec,
  type FallbackResult,
  type HeadlessCore,
  type HeadlessCoreConfig,
  type HeadlessError,
  type HeadlessRunOptions,
  type ProgressEvent,
  type ProgressSnapshot
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 120_000;

type CommandSpec = {
  command: string;
  args: string[];
};

type RunFailure = {
  error: HeadlessError;
  stdout: string;
  stderr: string;
};

export function createHeadlessCore(config: HeadlessCoreConfig = {}): HeadlessCore {
  return {
    async run(options) {
      return runWithFallback(config, options);
    }
  };
}

async function runWithFallback(config: HeadlessCoreConfig, options: HeadlessRunOptions): Promise<string> {
  const runId = randomUUID();
  let prompt = options.prompt;
  let agent = options.agent;
  let fallbackUsed = false;

  for (;;) {
    try {
      return await runOnce(config, { ...options, agent, prompt });
    } catch (cause) {
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

async function runOnce(config: HeadlessCoreConfig, options: HeadlessRunOptions): Promise<string> {
  validateRunOptions(options);
  const { command, args } = commandFor(options.agent, options.prompt, config.env ?? process.env);
  await emitProgress(options, { state: "starting", agent: options.agent, message: `Starting ${options.agent.provider}` });
  const result = await runCommand(command, args, {
    cwd: config.cwd ?? process.cwd(),
    env: config.env ?? process.env,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
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
}

function commandFor(agent: AgentSpec, prompt: string, env: NodeJS.ProcessEnv): CommandSpec {
  const provider = agent.provider;
  const modelArgs = agent.model && agent.model !== DEFAULT_MODEL_ID ? ["--model", agent.model] : [];
  const reasoningEffort =
    agent.reasoningEffort && agent.reasoningEffort !== DEFAULT_REASONING_EFFORT_ID ? agent.reasoningEffort : undefined;

  if (provider === "codex") {
    return {
      command: env.CODEX_BIN || "codex",
      args: [
        "exec",
        ...modelArgs,
        "--config",
        'approval_policy="never"',
        ...(reasoningEffort ? ["--config", `model_reasoning_effort="${reasoningEffort}"`] : []),
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
    return {
      command: env.CLAUDE_BIN || "claude",
      args: [
        "--print",
        "--output-format",
        "text",
        ...modelArgs,
        ...(reasoningEffort ? ["--effort", reasoningEffort] : []),
        prompt
      ]
    };
  }

  if (provider === "agy") {
    return {
      command: env.AGY_BIN || "agy",
      args: [...modelArgs, "--print-timeout", "2m", "--print", prompt]
    };
  }

  return {
    command: env.GROK_BIN || "grok",
    args: [...modelArgs, "--output-format", "plain", "--single", prompt]
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
