// Actor and workspace resolution for the v1 agent API.
//
// AUTH_MODE=local keeps the deterministic development workspace. AUTH_MODE=supabase
// verifies a Supabase browser access token and maps the user to a stable
// workspace in the local store until the project data model moves to Postgres.

import type { ApiRequestView } from "./handler";
import { ApiError } from "./errors";
import { ensureWorkspace } from "./store";
import { getSupabaseAuthUser, SupabaseServerConfigError } from "@/lib/supabase/server";

export const LOCAL_WORKSPACE_ID = "ws_local_dev";
export const LOCAL_WORKSPACE_NAME = "dev_workspace";
export const LOCAL_ACTOR_ID = "local_dev";

export type AuthMode = "local" | "supabase";

export interface Actor {
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

function workspaceIdForUser(userId: string) {
  return `ws_user_${userId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
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

  const token = req ? bearerToken(req) : null;
  if (!token) {
    throw new ApiError("unauthorized", "Missing Supabase bearer token.");
  }

  try {
    const user = await getSupabaseAuthUser(token);
    const workspaceId = workspaceIdForUser(user.id);
    await ensureWorkspace(workspaceId, user.email ?? "Supabase workspace");
    return {
      mode: "supabase",
      actor: { id: user.id, type: "user", email: user.email ?? null },
      workspaceId,
      isLocal: false,
    };
  } catch (err) {
    if (err instanceof SupabaseServerConfigError) {
      throw new ApiError("unauthorized", err.message);
    }
    throw new ApiError(
      "unauthorized",
      err instanceof Error ? err.message : "Invalid Supabase access token."
    );
  }
}
