// Shared request lifecycle for v1 routes: request IDs, auth resolution, body
// parsing, idempotency, and typed error envelopes.

import { createHash } from "crypto";
import { AuthContext, resolveAuth } from "./auth";
import { ApiError } from "./errors";
import { newRequestId } from "./ids";
import { ApiResult, runIdempotent } from "./idempotency";

export interface ApiRequestView {
  method: string;
  pathname: string;
  searchParams: URLSearchParams;
  header(name: string): string | null;
  rawBody(): Promise<string>;
}

export interface HandlerCtx {
  requestId: string;
  auth: AuthContext;
  req: ApiRequestView;
  body: unknown;
}

export type { ApiResult } from "./idempotency";

async function parseJsonBody(req: ApiRequestView): Promise<{ body: unknown; rawBody: string }> {
  const rawBody = await req.rawBody();
  if (rawBody.trim() === "") return { body: undefined, rawBody };
  try {
    return { body: JSON.parse(rawBody), rawBody };
  } catch {
    throw new ApiError("validation_failed", "Request body must be valid JSON.");
  }
}

// Read-only handler: resolves auth, runs fn, maps errors.
export async function handleRead(
  req: ApiRequestView,
  fn: (ctx: HandlerCtx) => Promise<ApiResult>,
  requestId = newRequestId()
): Promise<ApiResult> {
  const auth = await resolveAuth(req);
  return fn({ requestId, auth, req, body: undefined });
}

// Mutating handler: parses JSON, applies Idempotency-Key semantics, runs fn.
export async function handleMutation(
  req: ApiRequestView,
  fn: (ctx: HandlerCtx) => Promise<ApiResult>,
  requestId = newRequestId()
): Promise<ApiResult> {
  const auth = await resolveAuth(req);
  const { body, rawBody } = await parseJsonBody(req);
  const ctx: HandlerCtx = { requestId, auth, req, body };

  const key = req.header("Idempotency-Key");
  if (!key) {
    return fn(ctx);
  }

  const scope = `${auth.workspaceId}:${auth.actor.id}:${req.method}:${req.pathname}`;
  const bodyHash = createHash("sha256").update(rawBody).digest("hex");

  return runIdempotent(scope, key, bodyHash, () => fn(ctx));
}
