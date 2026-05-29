// Typed error envelope for /api/v1. Matches the API Contract V1 shape:
// { error: { code, message, requestId, details? } } with stable codes.

export type ErrorCode =
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

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 400,
  idempotency_conflict: 409,
  asset_not_ready: 409,
  asset_invalid: 400,
  brief_missing: 400,
  timeline_invalid: 422,
  job_not_cancelable: 409,
  job_failed: 500,
  render_failed: 500,
  model_output_invalid: 502,
  rate_limited: 429,
  internal_error: 500,
};

export interface ErrorDetails {
  fields?: { path: string; message: string }[];
  [key: string]: unknown;
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: ErrorDetails;

  constructor(code: ErrorCode, message: string, details?: ErrorDetails) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }

  envelope(requestId: string) {
    return {
      error: {
        code: this.code,
        message: this.message,
        requestId,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export function statusForCode(code: ErrorCode): number {
  return STATUS_BY_CODE[code];
}
