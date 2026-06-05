// Actor and workspace resolution for the v1 agent API.
//
// AUTH_MODE=local keeps the deterministic development workspace. AUTH_MODE=supabase
// verifies a Supabase access token and maps the caller to their DOMAIN identity
// (public.users.id) — never the auth user id (auth.uid()), per the Golden rule in
// docs/supabase-identity-and-rls.md.
//
// In supabase mode the heavy lifting (verify token, build RLS-enforced client,
// resolve public.users.id) is done once by authMiddleware (src/middleware/auth.ts),
// which stashes the result in the AsyncLocalStorage request context. resolveAuth
// reads that context. As a fallback (a v1 handler reached without the middleware,
// e.g. a direct adapter call), it verifies the token itself and resolves the same
// domain id via the same canonical RPC — so there is one auth->domain mapping.

import type { ApiRequestView } from "./handler";
import { ApiError } from "./errors";
import { ensureWorkspace } from "./store";
import {
  buildUserScopedSupabase,
  resolveAppUserId,
  SupabaseConfigError,
} from "@/lib/supabase/clients";
import { requestContext } from "@/lib/supabase/request-context";

// Must be a valid UUID: `workspaces.id` is a Postgres `uuid` column, so a
// plain string ("ws_local_dev") makes ensureWorkspace's select/insert throw
// "invalid input syntax for type uuid" before it can auto-create the workspace.
// Fixed (deterministic) so retried/concurrent local requests map to one tenant.
// Keep in sync with agent-api/runtime.ts LOCAL_WORKSPACE_ID.
export const LOCAL_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
export const LOCAL_WORKSPACE_NAME = "dev_workspace";
export const LOCAL_ACTOR_ID = "local_dev";

export type AuthMode = "local" | "supabase";

export interface Actor {
  /** Domain identity. In supabase mode this is public.users.id (NEVER auth.uid()). */
  id: string;
  type: "local" | "user" | "agent";
  email?: string | null;
}

export interface AuthContext {
  mode: AuthMode;
  actor: Actor;
  workspaceId: string;
  isLocal: boolean;
}

export function authMode(): AuthMode {
  return (process.env.AUTH_MODE || "local") === "local" ? "local" : "supabase";
}

export function isLocalMode(): boolean {
  return authMode() === "local";
}

export function bearerToken(req: ApiRequestView): string | null {
  const value = req.header("authorization")?.trim();
  if (!value?.toLowerCase().startsWith("bearer ")) return null;
  return value.slice("bearer ".length).trim() || null;
}

// Workspace key derived from the DOMAIN user id (public.users.id), not the auth
// id. The local JSON store is still keyed by a single workspace per user until
// the project data model moves to Postgres with real workspace_members. See the
// PR notes / spec §6.6 — multi-workspace selection is a follow-up.
function workspaceIdForUser(publicUserId: string) {
  return `ws_user_${publicUserId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

async function supabaseAuthContext(
  publicUserId: string,
  email: string | null
): Promise<AuthContext> {
  const workspaceId = workspaceIdForUser(publicUserId);
  await ensureWorkspace(workspaceId, email ?? "Supabase workspace", publicUserId);
  return {
    mode: "supabase",
    actor: { id: publicUserId, type: "user", email: email ?? null },
    workspaceId,
    isLocal: false,
  };
}

export async function resolveAuth(req?: ApiRequestView): Promise<AuthContext> {
  if (authMode() === "local") {
    await ensureWorkspace(LOCAL_WORKSPACE_ID, LOCAL_WORKSPACE_NAME);
    return {
      mode: "local",
      actor: { id: LOCAL_ACTOR_ID, type: "local" },
      workspaceId: LOCAL_WORKSPACE_ID,
      isLocal: true,
    };
  }

  // Preferred path: authMiddleware already verified the caller and resolved the
  // domain id into the request context. Trust it — no second Supabase round-trip.
  const ctx = requestContext.getStore();
  if (ctx) {
    return supabaseAuthContext(ctx.publicUserId, ctx.email);
  }

  // Fallback: no middleware context (e.g. a direct handler invocation). Verify the
  // bearer token and resolve the domain id ourselves, via the same canonical RPC.
  const token = req ? bearerToken(req) : null;
  if (!token) {
    throw new ApiError("unauthorized", "Missing Supabase bearer token.");
  }

  try {
    const supabase = buildUserScopedSupabase(token);
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) {
      throw error || new Error("Invalid Supabase access token.");
    }
    const publicUserId = await resolveAppUserId(supabase);
    if (!publicUserId) {
      // Verified auth user with no linked domain row -> treat as unauthenticated.
      throw new ApiError("unauthorized", "Invalid or expired session.");
    }
    return supabaseAuthContext(publicUserId, data.user.email ?? null);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err instanceof SupabaseConfigError) {
      throw new ApiError("unauthorized", err.message);
    }
    throw new ApiError(
      "unauthorized",
      err instanceof Error ? err.message : "Invalid Supabase access token."
    );
  }
}
