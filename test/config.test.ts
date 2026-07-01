import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveModelsConfigPath } from "../src/config.js";
import {
  DEFAULT_REASONING_EFFORT_ID,
  DEFAULT_MODEL_ID,
  ModelAvailabilityError,
  getAvailableReasoningEffortOptions,
  getAvailableModels
} from "../src/index.js";

let previousEnv: string | undefined;
let tmpDir: string;

beforeEach(async () => {
  previousEnv = process.env.HEADLESS_CORE_MODELS_PATH;
  tmpDir = await mkdtemp(path.join(tmpdir(), "headless-core-test-"));
});

afterEach(async () => {
  if (previousEnv === undefined) {
    delete process.env.HEADLESS_CORE_MODELS_PATH;
  } else {
    process.env.HEADLESS_CORE_MODELS_PATH = previousEnv;
  }
  await rm(tmpDir, { force: true, recursive: true });
});

describe("resolveModelsConfigPath", () => {
  it("resolves relative override paths from process cwd", () => {
    process.env.HEADLESS_CORE_MODELS_PATH = "local-models.json";
    expect(resolveModelsConfigPath()).toBe(path.resolve(process.cwd(), "local-models.json"));
  });
});

describe("getAvailableModels", () => {
  it("returns model ids for a configured agent", async () => {
    const configPath = path.join(tmpDir, "models.json");
    process.env.HEADLESS_CORE_MODELS_PATH = configPath;
    await writeFile(configPath, JSON.stringify({ models: { codex: ["gpt-5.5"] } }));

    await expect(getAvailableModels({ agent: "codex" })).resolves.toEqual([DEFAULT_MODEL_ID, "gpt-5.5"]);
  });

  it("returns the default model for a configured agent with no models", async () => {
    const configPath = path.join(tmpDir, "models.json");
    process.env.HEADLESS_CORE_MODELS_PATH = configPath;
    await writeFile(configPath, JSON.stringify({ models: { claude: [] } }));

    await expect(getAvailableModels({ agent: "claude" })).resolves.toEqual([DEFAULT_MODEL_ID]);
  });

  it("returns the default model for a supported agent missing from the config", async () => {
    const configPath = path.join(tmpDir, "models.json");
    process.env.HEADLESS_CORE_MODELS_PATH = configPath;
    await writeFile(configPath, JSON.stringify({ models: { codex: ["gpt-5.5"] } }));

    await expect(getAvailableModels({ agent: "grok" })).resolves.toEqual([DEFAULT_MODEL_ID]);
  });

  it("throws a typed error for missing config", async () => {
    process.env.HEADLESS_CORE_MODELS_PATH = path.join(tmpDir, "missing.json");

    await expect(getAvailableModels({ agent: "codex" })).rejects.toMatchObject({
      code: "MODELS_CONFIG_NOT_FOUND"
    } satisfies Partial<ModelAvailabilityError>);
  });

  it("throws a typed error for invalid json", async () => {
    const configPath = path.join(tmpDir, "models.json");
    process.env.HEADLESS_CORE_MODELS_PATH = configPath;
    await writeFile(configPath, "{");

    await expect(getAvailableModels({ agent: "codex" })).rejects.toMatchObject({
      code: "MODELS_CONFIG_INVALID_JSON"
    } satisfies Partial<ModelAvailabilityError>);
  });

  it("throws a typed error for invalid schema", async () => {
    const configPath = path.join(tmpDir, "models.json");
    process.env.HEADLESS_CORE_MODELS_PATH = configPath;
    await writeFile(configPath, JSON.stringify({ models: { codex: "gpt-5.5" } }));

    await expect(getAvailableModels({ agent: "codex" })).rejects.toMatchObject({
      code: "MODELS_CONFIG_INVALID_SCHEMA"
    } satisfies Partial<ModelAvailabilityError>);
  });

  it("throws a typed error for unsupported agents", async () => {
    const configPath = path.join(tmpDir, "models.json");
    process.env.HEADLESS_CORE_MODELS_PATH = configPath;
    await writeFile(configPath, JSON.stringify({ models: { codex: ["gpt-5.5"] } }));

    await expect(getAvailableModels({ agent: "not-real" })).rejects.toMatchObject({
      code: "UNKNOWN_AGENT"
    } satisfies Partial<ModelAvailabilityError>);
  });
});

describe("getAvailableReasoningEffortOptions", () => {
  it("returns reasoning effort choices for codex", () => {
    expect(getAvailableReasoningEffortOptions({ agent: "codex" })).toEqual([
      DEFAULT_REASONING_EFFORT_ID,
      "low",
      "medium",
      "high",
      "xhigh"
    ]);
  });

  it("returns effort choices for claude", () => {
    expect(getAvailableReasoningEffortOptions({ agent: "claude" })).toEqual([
      DEFAULT_REASONING_EFFORT_ID,
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ]);
  });

  it("returns only default for agents without reasoning effort options", () => {
    expect(getAvailableReasoningEffortOptions({ agent: "grok" })).toEqual([DEFAULT_REASONING_EFFORT_ID]);
  });

  it("throws a typed error for unsupported agents", () => {
    expect(() => getAvailableReasoningEffortOptions({ agent: "not-real" })).toThrow(ModelAvailabilityError);
  });
});
