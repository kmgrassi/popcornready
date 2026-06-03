import { NextResponse } from "next/server";
import { ApiError } from "./errors";

// Shared response helpers so every /api/v1 route emits the same envelope shape
// and request-id header.

export function jsonResponse(body: unknown, requestId: string, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "X-Request-Id": requestId },
  });
}

export function errorResponse(err: unknown, requestId: string): NextResponse {
  const apiError =
    err instanceof ApiError
      ? err
      : new ApiError("internal_error", err instanceof Error ? err.message : "Internal error.");
  return NextResponse.json(apiError.envelope(requestId), {
    status: apiError.status,
    headers: { "X-Request-Id": requestId },
  });
}
