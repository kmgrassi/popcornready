// Next.js glue for the /api/v1 route handlers. Imports next/server, so it is
// only used by route files — the smoke test imports runtime/jobs/workers
// directly and stays framework-free.

import { NextRequest, NextResponse } from "next/server";
import { getProject } from "@/lib/store";
import { Project } from "@/lib/types";
import { Actor, resolveActor, toErrorEnvelope } from "./runtime";

function readApiKey(req: NextRequest): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return req.headers.get("x-api-key");
}

// Resolve the calling agent from request headers + AUTH_MODE. Throws a typed
// ApiError (converted by errorResponse) when auth is unavailable.
export function requireActor(req: NextRequest): Actor {
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

export function errorResponse(err: unknown, reqId: string): NextResponse {
  const { status, body } = toErrorEnvelope(err, reqId);
  return NextResponse.json(body, { status });
}

export function getIdempotencyKey(req: NextRequest): string | null {
  return req.headers.get("idempotency-key");
}
