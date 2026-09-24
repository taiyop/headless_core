import {
  foldUidEffort,
  isEffortLevel,
  nonThinkingVariant,
  uidEffortLevel,
  uidFamilyBase,
  unsupportedEffort
} from "./effort.js";
import { DEFAULT_MODEL_ID } from "./types.js";
import type { EffortLevel } from "./types.js";

/**
 * Devin has no separate effort flag: thinking levels are model uid suffixes
 * (e.g. claude-opus-5-high). Fold the effort into the model id by replacing an
 * existing level suffix (keeping -fast/-priority tails), or appending it to a
 * family slug. Dotted slugs use dashes in variant uids: gpt-5.6-sol ->
 * gpt-5-6-sol-high. The result is a candidate only — callers must verify the
 * runtime/CLI actually advertises it instead of assuming it exists.
 */
export function devinModelWithEffort(model: string | undefined, effort: string | undefined): string | undefined {
  if (!model || model === DEFAULT_MODEL_ID || !effort) {
    return model;
  }
  return foldUidEffort(model, effort);
}

/** Strips the thinking-level suffix: "claude-opus-5-low-fast" -> "claude-opus-5". */
export function devinModelFamilyBase(uid: string): string {
  return uidFamilyBase(uid);
}

/**
 * Resolves a (model, effort) pair to one of the variant uids a devin runtime
 * advertises (e.g. the ACP model config option). Callers may hold a family
 * slug ("swe-2", dotted "claude-opus-5.5") while the runtime only offers
 * level-embedded uids ("swe-2-high", "claude-opus-5-5-medium"). Tried in
 * order: the effort-folded uid, the exact and dashed ids, then the family's
 * only advertised variant — any remaining level is applied separately via
 * the thought_level option.
 */
export function resolveDevinModelUid(
  model: string,
  effort: string | undefined,
  values: readonly string[]
): string | undefined {
  const dashed = model.replace(/\./g, "-");
  const candidates = [...(effort ? [devinModelWithEffort(model, effort)] : []), model, dashed];
  for (const candidate of candidates) {
    if (candidate && values.includes(candidate)) {
      return candidate;
    }
  }
  const base = devinModelFamilyBase(dashed);
  const family = values.filter((value) => devinModelFamilyBase(value) === base);
  return family.length === 1 ? family[0] : undefined;
}

/**
 * The outcome of resolving a devin (model, effort) request.
 */
export type DevinModelResolution = {
  /** The advertised variant uid to select. */
  modelUid: string;
  /**
   * A thought_level value to apply alongside the model when the requested
   * effort is not already carried by the uid suffix. Undefined when the
   * variant itself expresses the effort or the session offers no matching
   * thought_level.
   */
  thoughtLevel?: string;
};

/**
 * The effort levels a devin model can express, used for validation and error
 * messages: the levels embedded in the family's advertised variant uids plus
 * the thought_level values the session offers. "none" is included only when
 * the family has an explicit non-reasoning variant.
 */
export function devinSupportedEfforts(
  uids: readonly string[],
  familyBase: string,
  thoughtLevels: readonly string[]
): Set<string> {
  const supported = new Set<string>(thoughtLevels.filter(isEffortLevel));
  for (const uid of uids) {
    if (uidFamilyBase(uid) !== familyBase) {
      continue;
    }
    const level = uidEffortLevel(uid);
    if (level && isEffortLevel(level)) {
      supported.add(level);
    }
  }
  if (nonThinkingVariant(uids, familyBase)) {
    supported.add("none");
  }
  return supported;
}

/**
 * Resolves a devin model + explicit effort against the advertised variant
 * uids and thought_level values, enforcing the no-silent-conversion rules:
 *
 * - A requested level must map to a variant carrying that level
 *   (<model>-<level>), to an advertised uid whose embedded level matches, or
 *   to thought_level when it offers the level. Anything else is
 *   UNSUPPORTED_EFFORT — e.g. "low" is never silently upgraded to a family's
 *   only "-high" variant.
 * - "none" maps only to an explicit non-reasoning variant: a <model>-none uid
 *   or the family's single level-less sibling among thinking variants. It is
 *   never generated mechanically and never falls back to a thinking variant
 *   or thought_level.
 * - An undefined effort (the "default" selection) resolves the model without
 *   any level constraint: exact/dashed id, then the family's only variant.
 *
 * Throws EffortError for unsupported levels and a plain Error for models the
 * advertised list cannot resolve at all.
 */
export function resolveDevinModel(
  model: string,
  effort: EffortLevel | undefined,
  uids: readonly string[],
  thoughtLevels: readonly string[]
): DevinModelResolution {
  const dashed = model.replace(/\./g, "-");
  const base = uidFamilyBase(dashed);
  const family = uids.filter((uid) => uidFamilyBase(uid) === base);

  if (!effort) {
    const uid = resolveDevinModelUid(model, undefined, uids);
    if (!uid) {
      throw unknownDevinModel(model, uids);
    }
    return { modelUid: uid };
  }

  // The folded variant is an explicit level-carrying uid, accepted only when
  // advertised. thought_level still receives the level when offered, since a
  // stale thought_level may otherwise override the variant's level.
  const folded = foldUidEffort(model, effort);
  if (uids.includes(folded)) {
    return { modelUid: folded, thoughtLevel: thoughtLevels.includes(effort) ? effort : undefined };
  }

  if (effort === "none") {
    const off = nonThinkingVariant(uids, base);
    if (off) {
      return { modelUid: off };
    }
    throw unsupportedEffort("devin", model, effort, devinSupportedEfforts(uids, base, thoughtLevels));
  }

  const uid = resolveDevinModelUid(model, undefined, uids);
  if (!uid) {
    if (family.length > 0) {
      // The family exists but no variant carries the requested level.
      throw unsupportedEffort("devin", model, effort, devinSupportedEfforts(uids, base, thoughtLevels));
    }
    throw unknownDevinModel(model, uids);
  }

  const embedded = uidEffortLevel(uid);
  if (embedded === effort) {
    return { modelUid: uid, thoughtLevel: thoughtLevels.includes(effort) ? effort : undefined };
  }
  if (thoughtLevels.includes(effort)) {
    // The uid is level-less (or pins a different variant); thought_level
    // carries the requested effort instead.
    return { modelUid: uid, thoughtLevel: effort };
  }
  throw unsupportedEffort("devin", model, effort, devinSupportedEfforts(uids, base, thoughtLevels));
}

function unknownDevinModel(model: string, uids: readonly string[]): Error {
  return new Error(`Unknown devin model "${model}" (available: ${uids.join(", ") || "none"})`);
}
