import { spawn } from "node:child_process";
import { parseAgyModels } from "./inspectors.js";

const CATALOG_COMMAND_TIMEOUT_MS = 10_000;

/**
 * Provider capability snapshots fetched from agent CLIs. Results are cached
 * per binary for the process lifetime; a failed fetch is not cached so the
 * next run retries, and callers must treat `null` as "capabilities unknown —
 * degrade to provider-side validation".
 */
const catalogCache = new Map<string, Promise<unknown>>();

function cachedCatalog<T>(key: string, load: () => Promise<T | null>): Promise<T | null> {
  const existing = catalogCache.get(key);
  if (existing) {
    return existing as Promise<T | null>;
  }
  const pending = load().then(
    (value) => value,
    () => {
      catalogCache.delete(key);
      return null;
    }
  );
  catalogCache.set(key, pending);
  return pending;
}

/**
 * `codex debug models` catalog: model slug -> reasoning levels the model
 * advertises (e.g. low/medium/high/xhigh/max; provider-only levels such as
 * "ultra" are kept for membership checks but never offered as common values).
 */
export function codexModelEffortLevels(env: NodeJS.ProcessEnv): Promise<Map<string, string[]> | null> {
  const command = env.CODEX_BIN || "codex";
  return cachedCatalog(`codex:${command}`, async () => {
    const stdout = await runCatalogCommand(command, ["debug", "models"], env);
    const parsed = JSON.parse(stdout) as {
      models?: Array<{
        slug?: unknown;
        supported_reasoning_levels?: Array<{ effort?: unknown }>;
      }>;
    };
    const levels = new Map<string, string[]>();
    for (const model of parsed.models ?? []) {
      if (typeof model.slug !== "string") {
        continue;
      }
      levels.set(
        model.slug,
        (model.supported_reasoning_levels ?? [])
          .map((level) => level?.effort)
          .filter((effort): effort is string => typeof effort === "string")
      );
    }
    return levels;
  });
}

/**
 * `devin models list --format json` catalog: every variant model_uid the
 * account advertises. Level slugs are resolved against this list, so an empty
 * list means "unknown" rather than "no models".
 */
export function devinModelVariantUids(env: NodeJS.ProcessEnv): Promise<string[] | null> {
  const command = env.DEVIN_BIN || "devin";
  return cachedCatalog(`devin:${command}`, async () => {
    const stdout = await runCatalogCommand(command, ["models", "list", "--format", "json"], env);
    const parsed = JSON.parse(stdout) as {
      families?: Array<{ variants?: Array<{ model_uid?: unknown }> }>;
    };
    const uids: string[] = [];
    for (const family of parsed.families ?? []) {
      for (const variant of family.variants ?? []) {
        if (typeof variant.model_uid === "string") {
          uids.push(variant.model_uid);
        }
      }
    }
    return uids.length > 0 ? uids : null;
  });
}

/**
 * `agy models` catalog: selectable model ids (the first column of the
 * id<TAB>display-name listing). Level-embedded variant ids
 * (gemini-3.8-flash-low) are how agy exposes per-model thinking levels.
 */
export function agyModelIds(env: NodeJS.ProcessEnv): Promise<string[] | null> {
  const command = env.AGY_BIN || "agy";
  return cachedCatalog(`agy:${command}`, async () => {
    const stdout = await runCatalogCommand(command, ["models"], env);
    // Capability resolution needs slug-like ids (variant suffixes live on
    // ids); display names from older output formats are ignored here.
    const ids = parseAgyModels(stdout).filter((id) => /^[\w.:/-]+$/.test(id));
    return ids.length > 0 ? ids : null;
  });
}

function runCatalogCommand(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let settled = false;
    let stdout = "";
    let stderr = "";

    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        resolve(stdout.trim());
      }
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`Catalog command timed out: ${command} ${args.join(" ")}`));
    }, CATALOG_COMMAND_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (cause) => finish(cause instanceof Error ? cause : new Error(String(cause))));
    child.on("close", (code) => {
      if (code === 0) {
        finish();
        return;
      }
      finish(new Error(`Catalog command failed: ${command} ${args.join(" ")}: ${(stderr || stdout).trim()}`));
    });
  });
}
