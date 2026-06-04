// Canonical Supabase client module for @popcorn/api.
//
// Two clients, two purposes (see docs/scopes/express-auth-middleware.md §3 and
// docs/supabase-identity-and-rls.md Rule 5):
//
//   getServiceSupabase()  — service_role key, RLS BYPASSED. Trusted server ops
//                           only (invites, background jobs). Tenancy is the
//                           caller's responsibility in that code path. Never the
//                           request default; never placed in the request context.
//
//   getRequestSupabase()  — the user-scoped, RLS-ENFORCED client for the CURRENT
//                           request (anon key + the caller's bearer token), read
//                           from the per-request AsyncLocalStorage context that
//                           authMiddleware populates. This is the default for all
//                           request-driven data access.
//
//   getCurrentAppUserId() — the caller's public.users.id (DOMAIN id), resolved by
//                           the public.current_app_user_id() RPC on the request
//                           client. Never returns the auth id (Golden rule).

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requestContext } from "./request-context.js";

export class SupabaseConfigError extends Error {
  constructor(missing: string[]) {
    super(
      `Supabase is not configured: ${missing.join(", ")} ${
        missing.length === 1 ? "is" : "are"
      } required.`
    );
    this.name = "SupabaseConfigError";
  }
}

function readUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = (env.SUPABASE_URL ?? "").trim().replace(/\/$/, "");
  if (!url) throw new SupabaseConfigError(["SUPABASE_URL"]);
  return url;
}

/**
 * Service_role client. Bypasses RLS — for trusted server operations only that
 * must run outside the caller's row visibility (e.g. inviting a not-yet-signed-up
 * user). Tenancy MUST be enforced in the calling code. Memoized per process.
 */
let serviceClient: SupabaseClient | null = null;
export function getServiceSupabase(
  env: NodeJS.ProcessEnv = process.env
): SupabaseClient {
  if (serviceClient) return serviceClient;

  const url = (env.SUPABASE_URL ?? "").trim().replace(/\/$/, "");
  const serviceRoleKey = (env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  const missing: string[] = [];
  if (!url) missing.push("SUPABASE_URL");
  if (!serviceRoleKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (missing.length > 0) throw new SupabaseConfigError(missing);

  serviceClient = createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
  return serviceClient;
}

/**
 * Builds a user-scoped, RLS-enforced client for a single access token. Attaches
 * the caller's bearer token to an anon-key client, so every PostgREST request
 * runs as role `authenticated` with auth.uid() populated. Used by authMiddleware;
 * doubles as the verifier (auth.getUser(token)).
 */
export function buildUserScopedSupabase(
  accessToken: string,
  env: NodeJS.ProcessEnv = process.env
): SupabaseClient {
  const token = accessToken.trim();
  if (!token) throw new SupabaseConfigError(["accessToken"]);

  const url = readUrl(env);
  const anonKey = (env.SUPABASE_ANON_KEY ?? "").trim();
  if (!anonKey) throw new SupabaseConfigError(["SUPABASE_ANON_KEY"]);

  return createClient(url, anonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: { Authorization: `Bearer ${token}` },
    },
  });
}

/**
 * The user-scoped Supabase client for the current request (RLS-enforced),
 * retrieved from the AsyncLocalStorage context that authMiddleware established.
 * Throws if called outside an authenticated request (middleware not applied).
 */
export function getRequestSupabase(): SupabaseClient {
  const ctx = requestContext.getStore();
  if (!ctx) {
    throw new Error(
      "No request Supabase client — authMiddleware did not run for this request."
    );
  }
  return ctx.supabase;
}

/**
 * The caller's public.users.id (DOMAIN id) for the current request. Resolved once
 * by authMiddleware and cached on the request context; never the auth id.
 *
 * If called when a context exists, returns the pre-resolved id. As a fallback
 * (e.g. a code path that built a request client without the middleware), resolves
 * it live via the public.current_app_user_id() RPC on the request client.
 */
export async function getCurrentAppUserId(): Promise<string> {
  const ctx = requestContext.getStore();
  if (!ctx) {
    throw new Error(
      "No request context — authMiddleware did not run for this request."
    );
  }
  if (ctx.publicUserId) return ctx.publicUserId;
  const publicUserId = await resolveAppUserId(ctx.supabase);
  if (!publicUserId) {
    throw new Error("No linked public.users row for the current session.");
  }
  return publicUserId;
}

/**
 * Resolves public.users.id for a user-scoped client via the canonical RPC. Returns
 * null when the verified auth user has no linked domain row. Shared by the
 * middleware and the getCurrentAppUserId fallback so there is exactly one
 * interpretation of the auth -> domain mapping in app code (and it matches RLS).
 */
export async function resolveAppUserId(
  supabase: SupabaseClient
): Promise<string | null> {
  const { data, error } = await supabase.rpc("current_app_user_id");
  if (error) throw error;
  return (data as string | null) ?? null;
}
