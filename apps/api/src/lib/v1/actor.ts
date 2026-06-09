// Actor/workspace resolution for the older v1 generation stack. The synchronous
// resolver remains for local tests; request-aware routes should use
// resolveActorFromRequest so hosted mode goes through Supabase auth.

import type { ApiRequestView } from "@/lib/api/v1/handler";
import { resolveAuth } from "@/lib/api/v1/auth";
import { ApiError as SharedApiError } from "@/lib/api/v1/errors";
import { ApiError } from "./errors";

export interface Actor {
  actorId: string;
  workspaceId: string;
  agentClientId?: string;
  isLocal: boolean;
}

// Synchronous local actor used only by offline unit tests that drive the
// file-based v1 store. Its workspaceId/actorId are file-store tags (the file
// store keys by them in JSON, never as a DB primary key). The request-aware
// resolver below resolves the real DB-generated workspace uuid via find-or-create.
const LOCAL_ACTOR: Actor = {
  actorId: "local_dev",
  workspaceId: "dev_workspace",
  isLocal: true,
};

export function isLocalMode(): boolean {
  // local and hybrid both use the deterministic dev identity on this legacy
  // agent surface; only strict supabase mode goes through hosted auth.
  return (process.env.AUTH_MODE || "local").toLowerCase() !== "supabase";
}

// Test-only synchronous resolver (see LOCAL_ACTOR). Request-aware code paths use
// resolveActorFromRequest, which goes through Supabase/find-or-create.
export function resolveActor(): Actor {
  return LOCAL_ACTOR;
}

export async function resolveActorFromRequest(req: ApiRequestView): Promise<Actor> {
  // Both local and supabase modes go through resolveAuth so the workspace id is
  // the real DB-generated uuid (find-or-create), never the hardcoded
  // "dev_workspace" string — the v1 store persists workspace_id to Postgres.
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
