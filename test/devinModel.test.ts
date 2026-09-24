import { describe, expect, it } from "vitest";
import {
  devinModelFamilyBase,
  devinModelWithEffort,
  resolveDevinModel,
  resolveDevinModelUid
} from "../src/devinModel.js";
import { EffortError } from "../src/errors.js";

describe("devinModelWithEffort", () => {
  it("appends the effort to a family slug", () => {
    expect(devinModelWithEffort("swe-2", "high")).toBe("swe-2-high");
    expect(devinModelWithEffort("claude-opus-5", "medium")).toBe("claude-opus-5-medium");
  });

  it("converts dotted slugs to dashed variant uids", () => {
    expect(devinModelWithEffort("gpt-5.6-sol", "medium")).toBe("gpt-5-6-sol-medium");
    expect(devinModelWithEffort("claude-opus-5.5", "high")).toBe("claude-opus-5-5-high");
  });

  it("replaces an existing level suffix", () => {
    expect(devinModelWithEffort("swe-2-low", "high")).toBe("swe-2-high");
    expect(devinModelWithEffort("claude-opus-4-6-thinking", "medium")).toBe("claude-opus-4-6-medium");
  });

  it("keeps -fast/-priority tails when replacing the level", () => {
    expect(devinModelWithEffort("claude-opus-5-low-fast", "high")).toBe("claude-opus-5-high-fast");
    expect(devinModelWithEffort("swe-1-6-medium-priority", "max")).toBe("swe-1-6-max-priority");
  });

  it("passes through default model and empty effort", () => {
    expect(devinModelWithEffort("default", "high")).toBe("default");
    expect(devinModelWithEffort(undefined, "high")).toBeUndefined();
    expect(devinModelWithEffort("swe-2", undefined)).toBe("swe-2");
    expect(devinModelWithEffort("swe-2", "")).toBe("swe-2");
  });
});

describe("devinModelFamilyBase", () => {
  it("strips the level suffix", () => {
    expect(devinModelFamilyBase("swe-2-high")).toBe("swe-2");
    expect(devinModelFamilyBase("claude-opus-5-low-fast")).toBe("claude-opus-5");
    expect(devinModelFamilyBase("claude-opus-4-6-thinking")).toBe("claude-opus-4-6");
  });

  it("leaves bare uids untouched", () => {
    expect(devinModelFamilyBase("glm-5-2")).toBe("glm-5-2");
    expect(devinModelFamilyBase("swe-1-6-fast")).toBe("swe-1-6-fast");
  });
});

describe("resolveDevinModelUid", () => {
  const values = [
    "m-a",
    "fam-low",
    "fam-medium",
    "swe-2-high",
    "gpt-5-6-sol-medium",
    "glm-5-2",
    "adaptive"
  ];

  it("joins model and effort when the variant exists", () => {
    expect(resolveDevinModelUid("fam", "low", values)).toBe("fam-low");
    expect(resolveDevinModelUid("fam", "medium", values)).toBe("fam-medium");
    expect(resolveDevinModelUid("swe-2", "high", values)).toBe("swe-2-high");
  });

  it("uses the exact id when it is advertised", () => {
    expect(resolveDevinModelUid("m-a", "high", values)).toBe("m-a");
    expect(resolveDevinModelUid("glm-5-2", "medium", values)).toBe("glm-5-2");
    expect(resolveDevinModelUid("adaptive", undefined, values)).toBe("adaptive");
    expect(resolveDevinModelUid("swe-2-high", undefined, values)).toBe("swe-2-high");
  });

  it("converts dotted slugs to dashed uids", () => {
    expect(resolveDevinModelUid("gpt-5.6-sol", "medium", values)).toBe("gpt-5-6-sol-medium");
    expect(resolveDevinModelUid("gpt-5-6-sol-medium", undefined, values)).toBe("gpt-5-6-sol-medium");
  });

  it("falls back to the family's only advertised variant", () => {
    expect(resolveDevinModelUid("swe-2", undefined, values)).toBe("swe-2-high");
    expect(resolveDevinModelUid("swe-2", "low", values)).toBe("swe-2-high");
    expect(resolveDevinModelUid("swe-2-medium", undefined, values)).toBe("swe-2-high");
  });

  it("rejects ambiguous family slugs and unknown models", () => {
    expect(resolveDevinModelUid("fam", undefined, values)).toBeUndefined();
    expect(resolveDevinModelUid("fam", "high", values)).toBeUndefined();
    expect(resolveDevinModelUid("nope", undefined, values)).toBeUndefined();
    expect(resolveDevinModelUid("gpt-6", "medium", values)).toBeUndefined();
  });
});

describe("resolveDevinModel", () => {
  const uids = [
    "swe-2-high",
    "claude-opus-5-5-medium",
    "claude-opus-5-5-high",
    "claude-opus-5-5-max",
    "gpt-5-4-low",
    "gpt-5-4-none",
    "claude-opus-4-6",
    "claude-opus-4-6-thinking",
    "glm-5-2"
  ];
  const thoughtLevels = ["medium", "high", "max"];

  it("maps a requested level to the advertised variant carrying it", () => {
    expect(resolveDevinModel("claude-opus-5.5", "high", uids, [])).toEqual({
      modelUid: "claude-opus-5-5-high",
      thoughtLevel: undefined
    });
    expect(resolveDevinModel("swe-2", "high", uids, [])).toEqual({
      modelUid: "swe-2-high",
      thoughtLevel: undefined
    });
  });

  it("passes the level through thought_level when the resolved uid does not carry it", () => {
    // glm-5-2 is level-less; thought_level can still express the effort.
    expect(resolveDevinModel("glm-5-2", "high", uids, thoughtLevels)).toEqual({
      modelUid: "glm-5-2",
      thoughtLevel: "high"
    });
  });

  it("resolves the default effort without a level constraint", () => {
    expect(resolveDevinModel("swe-2", undefined, uids, thoughtLevels)).toEqual({
      modelUid: "swe-2-high",
      thoughtLevel: undefined
    });
    expect(resolveDevinModel("glm-5-2", undefined, uids, thoughtLevels)).toEqual({
      modelUid: "glm-5-2",
      thoughtLevel: undefined
    });
  });

  it("maps none to an explicit non-reasoning variant only", () => {
    // Advertised -none variant: direct mapping.
    expect(resolveDevinModel("gpt-5-4", "none", uids, thoughtLevels)).toEqual({
      modelUid: "gpt-5-4-none",
      thoughtLevel: undefined
    });
    // The bare uid among thinking siblings is the non-thinking variant.
    expect(resolveDevinModel("claude-opus-4-6", "none", uids, thoughtLevels)).toEqual({
      modelUid: "claude-opus-4-6",
      thoughtLevel: undefined
    });
  });

  it("rejects none when the family has no non-reasoning variant", () => {
    expect(() => resolveDevinModel("swe-2", "none", uids, thoughtLevels)).toThrowError(EffortError);
    try {
      resolveDevinModel("swe-2", "none", uids, thoughtLevels);
    } catch (cause) {
      expect((cause as EffortError).code).toBe("UNSUPPORTED_EFFORT");
      expect((cause as EffortError).message).toContain('does not support reasoning effort "none"');
      expect((cause as EffortError).message).not.toContain("swe-2-none");
    }
  });

  it("rejects a level no variant or thought_level can express", () => {
    // swe-2 only advertises -high; low must not silently become high.
    expect(() => resolveDevinModel("swe-2", "low", uids, thoughtLevels)).toThrowError(EffortError);
    // claude-opus-5.5 offers medium/high/max; minimal is not among them.
    expect(() => resolveDevinModel("claude-opus-5.5", "minimal", uids, thoughtLevels)).toThrowError(EffortError);
  });

  it("throws a plain unknown-model error for unresolvable slugs", () => {
    expect(() => resolveDevinModel("nope", "high", uids, thoughtLevels)).toThrowError(
      /Unknown devin model "nope"/
    );
    expect(() => resolveDevinModel("nope", undefined, uids, thoughtLevels)).toThrowError(
      /Unknown devin model "nope"/
    );
  });
});
