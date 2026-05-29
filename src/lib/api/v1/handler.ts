// Shared request lifecycle for v1 routes: request IDs, auth resolution, body
// parsing, idempotency, and typed error envelopes.

import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { AuthContext, resolveAuth } from "./auth";
import { ApiError } from "./errors";
import { newRequestId } from "./ids";
import { ApiResult, runIdempotent } from "./idempotency";
import { ok, errorResponse } from "./responses";

export interface HandlerCtx {
  requestId: string;
  auth: AuthContext;
  req: NextRequest;
  body: unknown;
}

export type { ApiResult } from "./idempotency";

function toResponse(result: ApiResult, requestId: string): NextResponse {
  return ok(result.body, requestId, result.status);
}

function toError(err: unknown, requestId: string): NextResponse {
  if (err instanceof ApiError) {
    return errorResponse(err, requestId);
  }
  const message = err instanceof Error ? err.message : "Unexpected error.";
  return errorResponse(new ApiError("internal_error", message), requestId);
}

async function parseJsonBody(req: NextRequest): Promise<{ body: unknown; rawBody: string }> {
  const rawBody = await req.text();
  if (rawBody.trim() === "") return { body: undefined, rawBody };
  try {
    return { body: JSON.parse(rawBody), rawBody };
  } catch {
    throw new ApiError("validation_failed", "Request body must be valid JSON.");
  }
}

// Read-only handler: resolves auth, runs fn, maps errors.
export async function handleRead(
  req: NextRequest,
  fn: (ctx: HandlerCtx) => Promise<ApiResult>
): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const auth = await resolveAuth();
    const result = await fn({ requestId, auth, req, body: undefined });
    return toResponse(result, requestId);
  } catch (err) {
    return toError(err, requestId);
  }
}

// Mutating handler: parses JSON, applies Idempotency-Key semantics, runs fn.
export async function handleMutation(
  req: NextRequest,
  fn: (ctx: HandlerCtx) => Promise<ApiResult>
): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const auth = await resolveAuth();
    const { body, rawBody } = await parseJsonBody(req);
    const ctx: HandlerCtx = { requestId, auth, req, body };

    const key = req.headers.get("Idempotency-Key");
    if (!key) {
      return toResponse(await fn(ctx), requestId);
    }

    const scope = `${auth.workspaceId}:${auth.actor.id}:${req.method}:${req.nextUrl.pathname}`;
    const bodyHash = createHash("sha256").update(rawBody).digest("hex");

    const result = await runIdempotent(scope, key, bodyHash, () => fn(ctx));
    return toResponse(result, requestId);
  } catch (err) {
    return toError(err, requestId);
  }
}
