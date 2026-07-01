import { isAgentId } from "./config.js";
import { ModelAvailabilityError } from "./errors.js";
import { DEFAULT_REASONING_EFFORT_ID } from "./types.js";
import type { GetAvailableReasoningEffortOptionsOptions } from "./types.js";

const REASONING_EFFORT_OPTIONS_BY_AGENT = {
  codex: [DEFAULT_REASONING_EFFORT_ID, "low", "medium", "high", "xhigh"],
  claude: [DEFAULT_REASONING_EFFORT_ID, "low", "medium", "high", "xhigh", "max"],
  agy: [DEFAULT_REASONING_EFFORT_ID],
  grok: [DEFAULT_REASONING_EFFORT_ID]
} as const;

export function getAvailableReasoningEffortOptions(options: GetAvailableReasoningEffortOptionsOptions): string[] {
  if (!isAgentId(options.agent)) {
    throw new ModelAvailabilityError("UNKNOWN_AGENT", `Unknown agent "${options.agent}"`);
  }

  return [...REASONING_EFFORT_OPTIONS_BY_AGENT[options.agent]];
}
