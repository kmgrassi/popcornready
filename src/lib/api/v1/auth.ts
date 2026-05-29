// Actor and workspace resolution for the v1 agent API.
//
// PR1 implements local-mode resolution only. In AUTH_MODE=local, requests resolve
// to a deterministic development workspace with no API key. Hosted mode (API keys
// + Supabase) is deferred to later PRs; until then it returns `unauthorized`.

import { ApiError } from "./errors";
import { ensureWorkspace } from "./store";

export const LOCAL_WORKSPACE_ID = "ws_local_dev";
export const LOCAL_WORKSPACE_NAME = "dev_workspace";
export const LOCAL_ACTOR_ID = "local_dev";

export type AuthMode = "local" | "hosted";

export interface Actor {
  id: string;
  type: "local" | "user" | "agent";
}

export interface AuthContext {
  mode: AuthMode;
  actor: Actor;
  workspaceId: string;
  isLocal: boolean;
}

export function authMode(): AuthMode {
  return (process.env.AUTH_MODE || "local") === "local" ? "local" : "hosted";
}

export function isLocalMode(): boolean {
  return authMode() === "local";
}

export async function resolveAuth(): Promise<AuthContext> {
  if (authMode() === "local") {
    await ensureWorkspace(LOCAL_WORKSPACE_ID, LOCAL_WORKSPACE_NAME);
    return {
      mode: "local",
      actor: { id: LOCAL_ACTOR_ID, type: "local" },
      workspaceId: LOCAL_WORKSPACE_ID,
      isLocal: true,
    };
  }

  throw new ApiError(
    "unauthorized",
    "Hosted authentication is not available yet. Set AUTH_MODE=local for local agent development."
  );
}
