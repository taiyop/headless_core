#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveModelsConfigPath } from "./config.js";
import { createHeadlessCore } from "./headlessCore.js";
import { inspectAllAgentModels } from "./inspectors.js";
import { AGENT_IDS, CLAUDE_MODEL_IDS, type AgentUsageLimits, type ModelsConfig } from "./types.js";

async function main(argv: string[]): Promise<number> {
  const [group, command] = argv;
  if (group === "usage") {
    return showUsage(argv.slice(1));
  }

  if (group !== "models") {
    printUsage();
    return 1;
  }

  if (command === "init") {
    return initModelsConfig();
  }

  if (command === "inspect") {
    return inspectModels();
  }

  printUsage();
  return 1;
}

async function initModelsConfig(): Promise<number> {
  const configPath = resolveModelsConfigPath();
  const config: ModelsConfig = {
    models: {
      codex: [],
      claude: [...CLAUDE_MODEL_IDS],
      agy: [],
      grok: [],
      devin: []
    }
  };

  try {
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, `${formatConfig(config)}\n`, { flag: "wx" });
    process.stdout.write(`Created ${configPath}\n`);
    return 0;
  } catch (cause) {
    if (isFileExistsError(cause)) {
      process.stderr.write(`Error: models config already exists: ${configPath}\n`);
      return 1;
    }

    throw cause;
  }
}

async function inspectModels(): Promise<number> {
  const configPath = resolveModelsConfigPath();
  const { config, warnings } = await inspectAllAgentModels(configPath);
  process.stdout.write(`${formatConfig(config)}\n`);
  for (const warning of warnings) {
    process.stderr.write(`${warning}\n`);
  }
  return 0;
}

async function showUsage(args: string[]): Promise<number> {
  const json = args.includes("--json");
  const agents = args.filter((arg) => arg !== "--json");
  const headless = createHeadlessCore();
  try {
    const results = agents.length
      ? await Promise.all(agents.map((agent) => headless.getUsageLimits({ agent })))
      : await headless.getAllUsageLimits();
    process.stdout.write(json ? `${JSON.stringify(results, null, 2)}\n` : formatUsage(results));
    return 0;
  } finally {
    await headless.shutdown();
  }
}

function formatUsage(results: AgentUsageLimits[]): string {
  const lines: string[] = [];
  for (const result of results) {
    lines.push(`${result.provider}${result.plan ? ` (${result.plan})` : ""}`);
    if (!result.available) {
      lines.push(`  ${result.supported ? "unavailable" : "not supported"}: ${result.error ?? "unknown"}`);
    } else if (result.windows.length === 0) {
      lines.push("  no usage windows reported");
    }
    for (const window of result.windows) {
      const remaining = window.remainingPercent === null ? "?" : `${window.remainingPercent}%`;
      const used = window.usedPercent === null ? "?" : `${window.usedPercent}%`;
      const resets = window.resetsAt ? `  resets ${new Date(window.resetsAt).toLocaleString()}` : "";
      lines.push(`  ${window.label.padEnd(22)} remaining ${remaining.padStart(4)}  (used ${used})${resets}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function formatConfig(config: ModelsConfig): string {
  const ordered: ModelsConfig = { models: {} };
  for (const agent of AGENT_IDS) {
    ordered.models[agent] = config.models[agent] ?? [];
  }
  return JSON.stringify(ordered, null, 2);
}

function printUsage(): void {
  process.stderr.write("Usage: headless-core models <init|inspect>\n       headless-core usage [agent...] [--json]\n");
}

function isFileExistsError(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EEXIST";
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((cause) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  });
