import { isAgentId } from "./config.js";
import { ModelAvailabilityError } from "./errors.js";
import { DEFAULT_REASONING_EFFORT_ID } from "./types.js";
import type { GetAvailableReasoningEffortOptionsOptions } from "./types.js";

/**
 * Provider-level effort vocabulary: the options a caller can meaningfully
 * select for each agent. Model-level support is still validated per request
 * (see src/effort.ts) — e.g. devin advertises every level because variant
 * uids span the whole range, but a given family may only carry some of them.
 */
const REASONING_EFFORT_OPTIONS_BY_AGENT = {
  // `model_reasoning_effort` can carry any level the model supports
  // (`none`/`minimal` included); `codex debug models` / model/list report the
  // per-model levels and the request is validated against them.
  codex: [DEFAULT_REASONING_EFFORT_ID, "none", "minimal", "low", "medium", "high", "xhigh", "max"],
  // `claude --effort` accepts low|medium|high|xhigh|max only — the flag has
  // no way to express none/minimal, so they are not offered.
  claude: [DEFAULT_REASONING_EFFORT_ID, "low", "medium", "high", "xhigh", "max"],
  // `agy --effort` accepts low|medium|high, but level-embedded variant model
  // ids (gemini-2-5-flash-none) can carry any level including a true
  // thinking-off "none", so the whole vocabulary is selectable; support is
  // resolved against the `agy models` variant catalog at run time.
  agy: [DEFAULT_REASONING_EFFORT_ID, "none", "minimal", "low", "medium", "high", "xhigh", "max"],
  grok: [DEFAULT_REASONING_EFFORT_ID, "low", "medium", "high"],
  // Devin has no separate effort flag; the effort is folded into the model
  // uid suffix (e.g. model "claude-opus-5" + effort "high" ->
  // --model claude-opus-5-high). Variant uids span the full level range
  // including explicit non-reasoning variants (-none), so the whole
  // vocabulary is selectable; per-model support is enforced at run time.
  devin: [DEFAULT_REASONING_EFFORT_ID, "none", "minimal", "low", "medium", "high", "xhigh", "max"]
} as const;

export function getAvailableReasoningEffortOptions(options: GetAvailableReasoningEffortOptionsOptions): string[] {
  if (!isAgentId(options.agent)) {
    throw new ModelAvailabilityError("UNKNOWN_AGENT", `Unknown agent "${options.agent}"`);
  }

  return [...REASONING_EFFORT_OPTIONS_BY_AGENT[options.agent]];
}
