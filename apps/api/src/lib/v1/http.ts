import { ApiError } from "./errors";

// Shared response helpers so every /api/v1 route emits the same envelope shape
// and request-id header.

export interface JsonResponseView {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

export function jsonResponse(body: unknown, requestId: string, status = 200): JsonResponseView {
  return {
    status,
    headers: { "X-Request-Id": requestId },
    body,
  };
}

export function errorResponse(err: unknown, requestId: string): JsonResponseView {
  const apiError =
    err instanceof ApiError
      ? err
      : new ApiError("internal_error", err instanceof Error ? err.message : "Internal error.");
  return {
    status: apiError.status,
    headers: { "X-Request-Id": requestId },
    body: apiError.envelope(requestId),
  };
}
