// Framework-agnostic helpers shared by the /api/v1 route handlers and tests:
// id generation, the typed error envelope, local-mode actor resolution, and
// idempotency-key extraction. Kept free of next/server imports so the smoke
// test can exercise it directly.

import { ApiErrorBody } from "./types";

export function newId(prefix: string): string {
  return `${prefix}_` + Math.random().toString(36).slice(2, 10);
}

export function requestId(): string {
  return newId("req");
}

// Typed API error with a stable code and an HTTP status. Routes convert it to
// the scope doc's Error Shape via toErrorEnvelope().
export class ApiError extends Error {
  code: string;
  status: number;
  details?: Record<string, unknown>;

  constructor(
    code: string,
    status: number,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function toErrorEnvelope(
  err: unknown,
  reqId: string
): { status: number; body: { error: ApiErrorBody } } {
  if (err instanceof ApiError) {
    return {
      status: err.status,
      body: {
        error: {
          code: err.code,
          message: err.message,
          requestId: reqId,
          details: err.details,
        },
      },
    };
  }
  const message = err instanceof Error ? err.message : "Unexpected error";
  return {
    status: 500,
    body: { error: { code: "internal_error", message, requestId: reqId } },
  };
}

export interface Actor {
  mode: "local";
  workspaceId: string;
  actorId: string;
}

// Local development workspace, per the scope doc's Local Development section.
// Deterministic so retried/concurrent requests map to the same tenant.
const LOCAL_WORKSPACE_ID = "ws_local_dev";
const LOCAL_ACTOR_ID = "agent_local_dev";

// Resolve the calling agent. In AUTH_MODE=local every request resolves to a
// deterministic development workspace with no API key. Hosted, key-based auth
// is PR1 and not implemented yet, so any non-local mode returns a typed
// not-implemented error rather than silently allowing access.
export function resolveActor(input: {
  authMode?: string | null;
  apiKey?: string | null;
}): Actor {
  if (input.authMode === "local") {
    return {
      mode: "local",
      workspaceId: LOCAL_WORKSPACE_ID,
      actorId: LOCAL_ACTOR_ID,
    };
  }
  // TODO(PR1): validate workspace-scoped API keys and resolve the workspace
  // from the key. Until PR1 lands, hosted mode is unavailable.
  throw new ApiError(
    "auth_not_configured",
    501,
    "Hosted API key authentication is not implemented yet. Set AUTH_MODE=local for local development.",
    { authMode: input.authMode ?? null }
  );
}
