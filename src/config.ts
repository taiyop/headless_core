import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { ModelAvailabilityError } from "./errors.js";
import { AGENT_IDS, type AgentId, type ModelsConfig } from "./types.js";

const MODELS_PATH_ENV = "HEADLESS_CORE_MODELS_PATH";

export function resolveModelsConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[MODELS_PATH_ENV];
  if (override && override.trim() !== "") {
    return path.isAbsolute(override) ? override : path.resolve(process.cwd(), override);
  }

  return path.join(homedir(), ".config", "headless-core", "models.json");
}

export function isAgentId(value: string): value is AgentId {
  return (AGENT_IDS as readonly string[]).includes(value);
}

export async function readModelsConfig(configPath = resolveModelsConfigPath()): Promise<ModelsConfig> {
  try {
    await access(configPath, constants.F_OK);
  } catch (cause) {
    throw new ModelAvailabilityError(
      "MODELS_CONFIG_NOT_FOUND",
      `Models config not found: ${configPath}`,
      { cause }
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8"));
  } catch (cause) {
    throw new ModelAvailabilityError(
      "MODELS_CONFIG_INVALID_JSON",
      `Models config is not valid JSON: ${configPath}`,
      { cause }
    );
  }

  return validateModelsConfig(parsed, configPath);
}

export function validateModelsConfig(value: unknown, configPath = "models.json"): ModelsConfig {
  if (!isRecord(value) || !isRecord(value.models)) {
    throw new ModelAvailabilityError(
      "MODELS_CONFIG_INVALID_SCHEMA",
      `Models config must have a "models" object: ${configPath}`
    );
  }

  const models: Partial<Record<AgentId, string[]>> = {};
  for (const [agent, modelIds] of Object.entries(value.models)) {
    if (!isAgentId(agent)) {
      throw new ModelAvailabilityError(
        "MODELS_CONFIG_INVALID_SCHEMA",
        `Models config contains unsupported agent "${agent}": ${configPath}`
      );
    }

    if (!Array.isArray(modelIds) || !modelIds.every((modelId) => typeof modelId === "string")) {
      throw new ModelAvailabilityError(
        "MODELS_CONFIG_INVALID_SCHEMA",
        `Models config entry for "${agent}" must be a string array: ${configPath}`
      );
    }

    models[agent] = modelIds;
  }

  return { models };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
