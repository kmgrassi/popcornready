// Response envelope helpers for the v1 agent API.

import { NextResponse } from "next/server";
import { ApiError } from "./errors";

export interface Pagination {
  limit: number;
  nextCursor: string | null;
}

export function ok(
  body: Record<string, unknown>,
  requestId: string,
  status = 200
): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "X-Request-Id": requestId },
  });
}

export function errorResponse(err: ApiError, requestId: string): NextResponse {
  return NextResponse.json(
    {
      error: {
        code: err.code,
        message: err.message,
        requestId,
        ...(err.details ? { details: err.details } : {}),
      },
    },
    { status: err.status, headers: { "X-Request-Id": requestId } }
  );
}
