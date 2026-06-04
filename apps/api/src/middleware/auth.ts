// Express auth middleware for @popcorn/api (Track B2).
//
// Ports the harper-server auth pattern and adapts it to our identity model
// (docs/scopes/express-auth-middleware.md, docs/supabase-identity-and-rls.md):
//
//   1. Extract the bearer access token        -> 403 if absent.
//   2. Verify the session via getUser(token)   -> 401 if invalid/expired.
//   3. Build a USER-SCOPED (RLS-enforced) client and use it as the verifier.
//   4. Resolve the caller's public.users.id via current_app_user_id() -> 401 if NULL.
//   5. Run the rest of the request inside the AsyncLocalStorage request context
//      { supabase, publicUserId, email } so getRequestSupabase()/getCurrentAppUserId()
//      work downstream without parameter threading.
//
// Golden rule: the auth user id (data.user.id / auth.uid()) is NEVER attached to
// the request, the context, or any payload. Handlers see public.users.id only.
//
// AUTH_MODE=local short-circuits all of this for deterministic local dev: no
// Supabase call, no context. resolveAuth (src/lib/api/v1/auth.ts) supplies the
// local workspace/actor in that mode.

import type { NextFunction, Request, Response } from "express";
import { ApiError, type ApiErrorCode } from "../core/errors.js";
import { isLocalMode } from "../lib/api/v1/auth.js";
import {
  buildUserScopedSupabase,
  resolveAppUserId,
  SupabaseConfigError,
} from "../lib/supabase/clients.js";
import { requestContext } from "../lib/supabase/request-context.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Caller's public.users.id (domain id) once authMiddleware resolves it. */
      publicUserId?: string;
    }
  }
}

function bearerToken(req: Request): string | null {
  const value = req.get("authorization")?.trim();
  if (!value?.toLowerCase().startsWith("bearer ")) return null;
  return value.slice("bearer ".length).trim() || null;
}

function sendError(
  res: Response,
  requestId: string,
  code: ApiErrorCode,
  message: string
) {
  // Reuse the canonical v1 envelope so SPA error handling stays uniform.
  res.status(new ApiError(code, message).status).json({
    error: { code, message, requestId },
  });
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const requestId = req.requestId;

  // Local dev: no Supabase. resolveAuth() injects the deterministic dev identity.
  if (isLocalMode()) {
    next();
    return;
  }

  try {
    const accessToken = bearerToken(req);
    // 403: nothing to authenticate (harper convention; see spec §4).
    if (!accessToken) {
      sendError(res, requestId, "forbidden", "Missing credentials.");
      return;
    }

    // User-scoped (RLS-enforced) client; also our verifier.
    const supabase = buildUserScopedSupabase(accessToken);

    const { data, error } = await supabase.auth.getUser(accessToken);
    if (error || !data.user) {
      sendError(res, requestId, "unauthorized", "Invalid or expired session.");
      return;
    }

    // Resolve the DOMAIN id via the same client -> parity with RLS policies.
    // A verified auth user with no linked public.users row is treated as
    // unauthenticated (do not leak that the auth user exists).
    let publicUserId: string | null;
    try {
      publicUserId = await resolveAppUserId(supabase);
    } catch {
      sendError(res, requestId, "unauthorized", "Invalid or expired session.");
      return;
    }
    if (!publicUserId) {
      sendError(res, requestId, "unauthorized", "Invalid or expired session.");
      return;
    }

    // auth id (data.user.id) intentionally NOT stored anywhere — Golden rule.
    req.publicUserId = publicUserId;

    requestContext.run(
      { supabase, publicUserId, email: data.user.email ?? null },
      () => next()
    );
  } catch (err) {
    // Missing URL/keys is a config bug, not a client error.
    if (err instanceof SupabaseConfigError) {
      // eslint-disable-next-line no-console
      console.error(`[api] auth misconfigured on ${req.method} ${req.path}:`, err);
      sendError(res, requestId, "internal_error", "Auth is not configured.");
      return;
    }
    // eslint-disable-next-line no-console
    console.warn(`[api] auth error on ${req.method} ${req.path}:`, err);
    sendError(res, requestId, "internal_error", "Internal server error.");
  }
}
