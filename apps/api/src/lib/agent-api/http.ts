// Framework-free HTTP helpers for agent-facing v1 route adapters.

import type { ApiRequestView } from "@/lib/api/v1/handler";
import { getProject } from "@/lib/store";
import { Project } from "@popcorn/shared/types";
import { Actor, resolveActor, toErrorEnvelope } from "./runtime";

function readApiKey(req: ApiRequestView): string | null {
  const auth = req.header("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return req.header("x-api-key");
}

// Resolve the calling agent from request headers + AUTH_MODE. Throws a typed
// ApiError (converted by errorResponse) when auth is unavailable.
export function requireActor(req: ApiRequestView): Actor {
  return resolveActor({
    authMode: process.env.AUTH_MODE,
    apiKey: readApiKey(req),
  });
}

// Load the project addressed by the path. The MVP store holds a single project,
// so we return it with its id overridden to echo the requested path id (never
// persisted). TODO(PR1): look up the real project within the actor's workspace.
export async function loadProject(projectId: string): Promise<Project> {
  const project = await getProject();
  return { ...project, id: projectId };
}

export function errorResponse(err: unknown, reqId: string) {
  const { status, body } = toErrorEnvelope(err, reqId);
  return { status, body };
}

export function getIdempotencyKey(req: ApiRequestView): string | null {
  return req.header("idempotency-key");
}
