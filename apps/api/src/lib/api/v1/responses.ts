// Response envelope helpers for the v1 agent API.

import { ApiError } from "./errors";

export interface Pagination {
  limit: number;
  nextCursor: string | null;
}

export interface JsonResponseView {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

export function ok(
  body: Record<string, unknown>,
  requestId: string,
  status = 200
): JsonResponseView {
  return {
    status,
    headers: { "X-Request-Id": requestId },
    body,
  };
}

export function errorResponse(err: ApiError, requestId: string): JsonResponseView {
  return {
    status: err.status,
    headers: { "X-Request-Id": requestId },
    body: err.envelope(requestId),
  };
}
