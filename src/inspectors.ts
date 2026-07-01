import { spawn } from "node:child_process";
import { AGENT_IDS, CLAUDE_MODEL_IDS, type AgentId, type ModelsConfig } from "./types.js";

const INSPECT_COMMAND_TIMEOUT_MS = 10_000;

type InspectResult = {
  agent: AgentId;
  models: string[];
  warning?: string;
};

export async function inspectAllAgentModels(configPath: string): Promise<{
  config: ModelsConfig;
  warnings: string[];
}> {
  const models: ModelsConfig["models"] = {};
  const warnings: string[] = [];

  for (const agent of AGENT_IDS) {
    const result = await inspectAgentModels(agent);
    models[agent] = result.models;
    if (result.warning) {
      warnings.push(formatInspectWarning(agent, result.warning, configPath));
    }
  }

  return { config: { models }, warnings };
}

export async function inspectAgentModels(agent: AgentId): Promise<InspectResult> {
  try {
    if (agent === "codex") {
      return { agent, models: parseCodexModels(await run("codex", ["debug", "models"])) };
    }

    if (agent === "claude") {
      return { agent, models: [...CLAUDE_MODEL_IDS] };
    }

    if (agent === "agy") {
      return { agent, models: parseAgyModels(await run("agy", ["models"])) };
    }

    return { agent, models: parseGrokModels(await run("grok", ["models"])) };
  } catch (cause) {
    return { agent, models: [], warning: commandFailureReason(agent, cause) };
  }
}

export function parseCodexModels(stdout: string): string[] {
  const catalog = JSON.parse(stdout) as {
    models?: Array<{ slug?: unknown; visibility?: unknown }>;
  };

  if (!Array.isArray(catalog.models)) {
    return [];
  }

  return catalog.models
    .filter((model) => model.visibility === "list" && typeof model.slug === "string")
    .map((model) => model.slug as string);
}

export function parseAgyModels(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function parseGrokModels(stdout: string): string[] {
  const lines = stripAnsi(stdout).split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "Available models:");
  if (start === -1) {
    return [];
  }

  return lines
    .slice(start + 1)
    .map((line) => line.match(/^\s*[-*]\s+(.+?)(?:\s+\(default\))?\s*$/)?.[1])
    .filter((modelId): modelId is string => Boolean(modelId));
}

export function formatInspectWarning(agent: AgentId, reason: string, configPath: string): string {
  return `Warning: failed to inspect models for ${agent}. ${reason}. Add models manually in ${configPath}.`;
}

export function commandFailureReason(agent: AgentId, cause: unknown): string {
  const command =
    agent === "codex" ? "codex debug models" : agent === "agy" ? "agy models" : "grok models";
  const stderr = getErrorOutput(cause, "stderr");
  if (stderr) {
    return `Command failed: ${command}: ${oneLine(stderr)}`;
  }

  const stdout = getErrorOutput(cause, "stdout");
  if (stdout) {
    return `Command failed: ${command}: ${oneLine(stdout)}`;
  }

  if (getErrorKilled(cause)) {
    return `Command timed out: ${command}`;
  }

  const signal = getErrorSignal(cause);
  if (signal) {
    return `Command failed: ${command} (${signal})`;
  }

  const message = cause instanceof Error && cause.message ? oneLine(cause.message) : "";
  if (message.startsWith(`Command failed: ${command}`)) {
    return message;
  }
  return `Command failed: ${command}${message ? `: ${message}` : ""}`;
}

async function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let settled = false;
    let stdout = "";
    let stderr = "";

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      rejectOnce(createCommandError(command, args, stdout, stderr, true, "SIGTERM"));
    }, INSPECT_COMMAND_TIMEOUT_MS);

    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };

    const resolveOnce = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(stdout);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (cause) => {
      rejectOnce(createCommandError(command, args, stdout, stderr, false, undefined, cause));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      if (code === 0) {
        resolveOnce();
        return;
      }
      rejectOnce(createCommandError(command, args, stdout, stderr, false, signal ?? undefined));
    });
  });
}

function createCommandError(
  command: string,
  args: string[],
  stdout: string,
  stderr: string,
  killed: boolean,
  signal?: string,
  cause?: unknown
): Error & { stdout: string; stderr: string; killed: boolean; signal?: string } {
  const fullCommand = [command, ...args].join(" ");
  const message = stderr || stdout ? `Command failed: ${fullCommand}\n${stderr || stdout}` : `Command failed: ${fullCommand}`;
  const error = new Error(message, { cause }) as Error & {
    stdout: string;
    stderr: string;
    killed: boolean;
    signal?: string;
  };
  error.stdout = stdout;
  error.stderr = stderr;
  error.killed = killed;
  if (signal) {
    error.signal = signal;
  }
  return error;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function oneLine(value: string): string {
  return value.split(/\r?\n/)[0]?.trim() ?? "";
}

function getErrorOutput(cause: unknown, key: "stdout" | "stderr"): string {
  if (typeof cause !== "object" || cause === null || !(key in cause)) {
    return "";
  }

  const value = (cause as Record<typeof key, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function getErrorSignal(cause: unknown): string {
  if (typeof cause !== "object" || cause === null || !("signal" in cause)) {
    return "";
  }

  const value = (cause as { signal?: unknown }).signal;
  return typeof value === "string" ? value : "";
}

function getErrorKilled(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null || !("killed" in cause)) {
    return false;
  }

  return (cause as { killed?: unknown }).killed === true;
}
