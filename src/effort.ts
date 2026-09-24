import { EffortError } from "./errors.js";
import {
  DEFAULT_REASONING_EFFORT_ID,
  EFFORT_LEVELS,
  type EffortLevel
} from "./types.js";

export function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value);
}

/**
 * Normalizes a reasoningEffort input. "default", "" and undefined all mean
 * "no explicit effort" and return undefined — the provider/CLI/model default
 * then applies, identical to omitting the option. Concrete levels pass
 * through; anything else is rejected instead of reaching the provider.
 */
export function parseRequestedEffort(value: string | undefined): EffortLevel | undefined {
  if (!value || value === DEFAULT_REASONING_EFFORT_ID) {
    return undefined;
  }
  if (isEffortLevel(value)) {
    return value;
  }
  const supported = [DEFAULT_REASONING_EFFORT_ID, ...EFFORT_LEVELS];
  throw new EffortError(
    "INVALID_EFFORT",
    `Unknown reasoning effort "${value}". Expected one of: ${supported.join(", ")}.`,
    { effort: value, supportedEfforts: supported }
  );
}

/** Orders levels by the canonical none -> max progression for messages. */
export function sortEffortLevels(levels: Iterable<string>): string[] {
  const order = new Map<string, number>(EFFORT_LEVELS.map((level, index) => [level, index]));
  return [...new Set(levels)].sort(
    (a, b) =>
      (order.get(a) ?? EFFORT_LEVELS.length) - (order.get(b) ?? EFFORT_LEVELS.length) ||
      a.localeCompare(b)
  );
}

/**
 * Builds the "unsupported effort" error every adapter raises when a model
 * cannot express the requested level. `supported` lists the levels the model
 * actually accepts; unknown/non-vocabulary entries are filtered out.
 */
export function unsupportedEffort(
  provider: string,
  model: string | undefined,
  effort: string,
  supported: Iterable<string>
): EffortError {
  const sorted = sortEffortLevels([...supported].filter(isEffortLevel));
  const subject = model ? `Model "${model}"` : `The default ${provider} model`;
  const suffix = sorted.length
    ? ` Supported efforts: ${sorted.join(", ")}.`
    : " It does not accept a configurable reasoning effort.";
  return new EffortError(
    "UNSUPPORTED_EFFORT",
    `${subject} does not support reasoning effort "${effort}".${suffix}`,
    { effort, supportedEfforts: sorted }
  );
}

/**
 * Level-embedded model uids (devin and agy variants) carry the thinking level
 * as a dash suffix, optionally followed by a -fast/-priority speed tail:
 * claude-opus-5-high, claude-opus-5-low-fast. "-thinking" marks a thinking
 * variant that has no numeric level of its own.
 */
const LEVEL_UID_SUFFIX = /-(none|minimal|low|medium|high|xhigh|max|thinking)(-(?:fast|priority))?$/;

/** The level embedded in a variant uid, or undefined for a level-less uid. */
export function uidEffortLevel(uid: string): string | undefined {
  return uid.match(LEVEL_UID_SUFFIX)?.[1];
}

/** Strips the level suffix (keeping the family base): "claude-opus-5-low-fast" -> "claude-opus-5". */
export function uidFamilyBase(uid: string): string {
  return uid.replace(LEVEL_UID_SUFFIX, "");
}

/**
 * Produces the candidate variant uid for a model+effort pair: replaces an
 * existing level suffix (keeping -fast/-priority tails) or appends the level
 * to the (dash-normalized) family slug. The result is only usable when a
 * runtime actually advertises it — callers must verify membership instead of
 * assuming the variant exists.
 */
export function foldUidEffort(model: string, effort: string): string {
  if (LEVEL_UID_SUFFIX.test(model)) {
    return model.replace(LEVEL_UID_SUFFIX, `-${effort}$2`);
  }
  return `${model.replace(/\./g, "-")}-${effort}`;
}

/**
 * Finds the explicit no-thinking variant of a family: the single level-less
 * sibling among uids that carry a level suffix (e.g. "claude-opus-4-6" next to
 * "claude-opus-4-6-thinking"). A lone level-less uid is not treated as a
 * non-reasoning variant — its thinking behavior is unknown, so `none` must
 * not silently map to it.
 */
export function nonThinkingVariant(uids: readonly string[], familyBase: string): string | undefined {
  const family = uids.filter((uid) => uidFamilyBase(uid) === familyBase);
  if (family.length < 2) {
    return undefined;
  }
  const bare = family.filter((uid) => uidEffortLevel(uid) === undefined);
  return bare.length === 1 ? bare[0] : undefined;
}
