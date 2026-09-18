import { isAgentId } from "./config.js";
import { ModelAvailabilityError } from "./errors.js";
import { DEFAULT_REASONING_EFFORT_ID } from "./types.js";
import type { GetAvailableReasoningEffortOptionsOptions } from "./types.js";

const REASONING_EFFORT_OPTIONS_BY_AGENT = {
  codex: [DEFAULT_REASONING_EFFORT_ID, "low", "medium", "high", "xhigh"],
  claude: [DEFAULT_REASONING_EFFORT_ID, "low", "medium", "high", "xhigh", "max"],
  agy: [DEFAULT_REASONING_EFFORT_ID],
  grok: [DEFAULT_REASONING_EFFORT_ID, "low", "medium", "high"],
  // Devin has no separate effort flag; the effort is folded into the model
  // uid suffix (e.g. model "claude-opus-5" + effort "high" ->
  // --model claude-opus-5-high). Not every family supports every level.
  devin: [DEFAULT_REASONING_EFFORT_ID, "low", "medium", "high", "xhigh", "max"]
} as const;

export function getAvailableReasoningEffortOptions(options: GetAvailableReasoningEffortOptionsOptions): string[] {
  if (!isAgentId(options.agent)) {
    throw new ModelAvailabilityError("UNKNOWN_AGENT", `Unknown agent "${options.agent}"`);
  }

  return [...REASONING_EFFORT_OPTIONS_BY_AGENT[options.agent]];
}
