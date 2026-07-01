#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveModelsConfigPath } from "./config.js";
import { inspectAllAgentModels } from "./inspectors.js";
import { AGENT_IDS, CLAUDE_MODEL_IDS, type ModelsConfig } from "./types.js";

async function main(argv: string[]): Promise<number> {
  const [group, command] = argv;
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
      grok: []
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

function formatConfig(config: ModelsConfig): string {
  const ordered: ModelsConfig = { models: {} };
  for (const agent of AGENT_IDS) {
    ordered.models[agent] = config.models[agent] ?? [];
  }
  return JSON.stringify(ordered, null, 2);
}

function printUsage(): void {
  process.stderr.write("Usage: headless-core models <init|inspect>\n");
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
