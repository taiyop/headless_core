export type ModelAvailabilityErrorCode =
  | "MODELS_CONFIG_NOT_FOUND"
  | "MODELS_CONFIG_INVALID_JSON"
  | "MODELS_CONFIG_INVALID_SCHEMA"
  | "UNKNOWN_AGENT";

export class ModelAvailabilityError extends Error {
  readonly code: ModelAvailabilityErrorCode;

  constructor(code: ModelAvailabilityErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelAvailabilityError";
    this.code = code;
  }
}

export type HeadlessSessionErrorCode =
  | "UNSUPPORTED_TRANSPORT"
  | "RUNTIME_START_FAILED"
  | "PROTOCOL_ERROR"
  | "SESSION_CLOSED"
  | "REQUEST_TIMEOUT"
  | "REQUEST_ABORTED";

export class HeadlessSessionError extends Error {
  readonly code: HeadlessSessionErrorCode;

  constructor(code: HeadlessSessionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HeadlessSessionError";
    this.code = code;
  }
}

export type EffortErrorCode = "INVALID_EFFORT" | "UNSUPPORTED_EFFORT";

/**
 * Raised when a reasoning effort selection cannot be honored:
 *
 * - `INVALID_EFFORT`: the value is outside the common effort vocabulary
 *   (not one of default/none/minimal/low/medium/high/xhigh/max).
 * - `UNSUPPORTED_EFFORT`: the value is valid but the selected model cannot
 *   express it. The error carries the model's supported levels and is never
 *   resolved by silently converting to a different level.
 */
export class EffortError extends Error {
  readonly code: EffortErrorCode;
  readonly effort: string;
  readonly supportedEfforts: readonly string[];

  constructor(
    code: EffortErrorCode,
    message: string,
    details?: { effort?: string; supportedEfforts?: readonly string[] },
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "EffortError";
    this.code = code;
    this.effort = details?.effort ?? "";
    this.supportedEfforts = details?.supportedEfforts ?? [];
  }
}

export type ToolsErrorCode = "INVALID_TOOLS" | "UNSUPPORTED_TOOLS";

/**
 * Raised when `agent.tools` cannot be honored:
 *
 * - `INVALID_TOOLS`: the spec is malformed (non-string tool names or rules,
 *   or an unknown permissionMode).
 * - `UNSUPPORTED_TOOLS`: the provider does not support opt-in tools (every
 *   provider except claude). The spec is never silently ignored.
 */
export class ToolsError extends Error {
  readonly code: ToolsErrorCode;

  constructor(code: ToolsErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ToolsError";
    this.code = code;
  }
}
