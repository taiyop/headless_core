import { isAgentId, readModelsConfig, resolveModelsConfigPath } from "./config.js";
import { ModelAvailabilityError } from "./errors.js";
import { DEFAULT_MODEL_ID } from "./types.js";
import type { GetAvailableModelsOptions } from "./types.js";

export async function getAvailableModels(options: GetAvailableModelsOptions): Promise<string[]> {
  const configPath = resolveModelsConfigPath();
  const config = await readModelsConfig(configPath);

  if (!isAgentId(options.agent)) {
    throw new ModelAvailabilityError(
      "UNKNOWN_AGENT",
      `Unknown agent "${options.agent}" in models config: ${configPath}`
    );
  }

  return withDefaultModel(config.models[options.agent] ?? []);
}

export function withDefaultModel(models: string[]): string[] {
  return [DEFAULT_MODEL_ID, ...models.filter((model) => model !== DEFAULT_MODEL_ID)];
}
