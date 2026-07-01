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
