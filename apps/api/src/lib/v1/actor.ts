// Actor/workspace resolution for the older v1 generation stack. The synchronous
// resolver remains for local tests; request-aware routes should use
// resolveActorFromRequest so hosted mode goes through Supabase auth.

import type { ApiRequestView } from "@/lib/api/v1/handler";
import { LOCAL_ACTOR_ID, LOCAL_WORKSPACE_ID, resolveAuth } from "@/lib/api/v1/auth";
import { ApiError as SharedApiError } from "@/lib/api/v1/errors";
import { ApiError } from "./errors";

export interface Actor {
  actorId: string;
  workspaceId: string;
  agentClientId?: string;
  isLocal: boolean;
}

const LOCAL_ACTOR: Actor = {
  actorId: LOCAL_ACTOR_ID,
  workspaceId: LOCAL_WORKSPACE_ID,
  isLocal: true,
};

export function isLocalMode(): boolean {
  return (process.env.AUTH_MODE || "local") === "local";
}

// In AUTH_MODE=local the API bypasses auth and resolves to the deterministic
// dev actor/workspace. Hosted resolution is deferred to PR1.
export function resolveActor(): Actor {
  if (isLocalMode()) return LOCAL_ACTOR;
  // Hosted auth is not implemented in this PR. Treat as local for now so the
  // contract stays stable; PR1 replaces this with real token/key resolution.
  return LOCAL_ACTOR;
}

export async function resolveActorFromRequest(req: ApiRequestView): Promise<Actor> {
  if (isLocalMode()) return LOCAL_ACTOR;
  try {
    const auth = await resolveAuth(req);
    return {
      actorId: auth.actor.id,
      workspaceId: auth.workspaceId,
      isLocal: auth.isLocal,
    };
  } catch (err) {
    if (err instanceof SharedApiError) {
      throw new ApiError(err.code, err.message, err.details);
    }
    throw err;
  }
}
