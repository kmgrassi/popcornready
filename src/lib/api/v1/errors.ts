// Typed error envelope for the versioned agent API.
// Codes are stable and machine-readable per docs/scopes/api-contract-v1.md.

export type ApiErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "validation_failed"
  | "idempotency_conflict"
  | "asset_not_ready"
  | "asset_invalid"
  | "brief_missing"
  | "timeline_invalid"
  | "job_not_cancelable"
  | "job_failed"
  | "render_failed"
  | "model_output_invalid"
  | "rate_limited"
  | "internal_error";

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 400,
  idempotency_conflict: 409,
  asset_not_ready: 409,
  asset_invalid: 400,
  brief_missing: 400,
  timeline_invalid: 400,
  job_not_cancelable: 409,
  job_failed: 422,
  render_failed: 500,
  model_output_invalid: 502,
  rate_limited: 429,
  internal_error: 500,
};

export interface FieldError {
  path: string;
  message: string;
}

export interface ApiErrorDetails {
  fields?: FieldError[];
  [key: string]: unknown;
}

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details?: ApiErrorDetails;

  constructor(code: ApiErrorCode, message: string, details?: ApiErrorDetails) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }
}

export function validationError(
  message: string,
  fields?: FieldError[]
): ApiError {
  return new ApiError("validation_failed", message, fields ? { fields } : undefined);
}

export function notFound(message: string): ApiError {
  return new ApiError("not_found", message);
}
