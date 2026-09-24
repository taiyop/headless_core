import {
  foldUidEffort,
  isEffortLevel,
  uidEffortLevel,
  uidFamilyBase,
  unsupportedEffort
} from "./effort.js";
import type { EffortLevel } from "./types.js";

/**
 * The levels agy's own `--effort` flag accepts. The flag is the fallback
 * effort channel for models that are not level-embedded variants.
 */
export const AGY_FLAG_EFFORTS: readonly EffortLevel[] = ["low", "medium", "high"];

export type AgyEffortResolution = {
  /** The model id to pass via --model (possibly rewritten to a variant). */
  model: string | undefined;
  /** The value for `agy --effort`, when the effort is not carried by a variant. */
  flagEffort?: string;
};

/**
 * Effort levels the selected agy model can express: the --effort flag range
 * plus the levels embedded in the model family's advertised variant ids
 * (e.g. gemini-3.8-flash-low/medium/high). "none" only counts when the family
 * advertises an explicit `<model>-none` variant — a bare level-less uid does
 * not imply non-thinking on agy (e.g. "Claude Sonnet 4.6 (Thinking)" is a
 * level-less uid that still thinks).
 */
export function agySupportedEfforts(
  ids: readonly string[],
  familyBase: string | undefined
): Set<string> {
  const supported = new Set<string>(AGY_FLAG_EFFORTS);
  if (!familyBase) {
    return supported;
  }
  for (const uid of ids) {
    if (uidFamilyBase(uid) !== familyBase) {
      continue;
    }
    const level = uidEffortLevel(uid);
    if (level && isEffortLevel(level)) {
      supported.add(level);
    }
  }
  return supported;
}

/**
 * Resolves an agy model + explicit effort. Agy (the Antigravity CLI) exposes
 * Gemini-family thinking levels two ways: level-embedded variant ids
 * (gemini-3.8-flash-low) and the `--effort low|medium|high` flag.
 *
 * - A variant carrying the requested level wins when the runtime advertises
 *   it — the variant is the authoritative level selection.
 * - "none" maps only to an advertised `<model>-none` variant (handled by the
 *   folded check); anything else is UNSUPPORTED_EFFORT. It is never folded
 *   mechanically and never degrades to "minimal"/"low".
 * - Levels outside the flag range with no matching variant are unsupported.
 * - Everything else falls back to `--effort`, which also covers level-less
 *   models and the default model.
 */
export function resolveAgyEffort(
  model: string | undefined,
  effort: EffortLevel,
  ids: readonly string[] | null
): AgyEffortResolution {
  if (ids && model) {
    const folded = foldUidEffort(model, effort);
    if (ids.includes(folded)) {
      return { model: folded };
    }
    const base = uidFamilyBase(model);
    if (effort === "none" || !AGY_FLAG_EFFORTS.includes(effort)) {
      throw unsupportedEffort("agy", model, effort, agySupportedEfforts(ids, base));
    }
    return { model, flagEffort: effort };
  }
  if (!AGY_FLAG_EFFORTS.includes(effort)) {
    throw unsupportedEffort("agy", model, effort, AGY_FLAG_EFFORTS);
  }
  return { model, flagEffort: effort };
}
