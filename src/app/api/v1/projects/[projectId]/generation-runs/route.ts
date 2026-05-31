import { NextRequest } from "next/server";

import { errorResponse, jsonResponse } from "@/lib/v1/http";
import { requestId as newRequestId } from "@/lib/v1/ids";
import {
  CreateGenerationRunBody,
  createRunWithSeedStages,
  getGenerationRunStore,
} from "@/lib/v1/generation-runs";

export const dynamic = "force-dynamic";

// POST /api/v1/projects/:projectId/generation-runs
// Creates a generation run with its initial queued stages and returns 202
// with a pollable runId. Backend progress emission (scope PR 3) wires real
// stage transitions; this endpoint creates the polling surface.
export async function POST(
  req: NextRequest,
  { params }: { params: { projectId: string } }
) {
  const requestId = newRequestId();
  try {
    const store = getGenerationRunStore();

    let body: CreateGenerationRunBody;
    try {
      body = (await req.json()) as CreateGenerationRunBody;
    } catch {
      body = {};
    }

    const payload = await createRunWithSeedStages({
      store,
      projectId: params.projectId,
      body,
    });

    return jsonResponse(payload, requestId, 202);
  } catch (err) {
    return errorResponse(err, requestId);
  }
}

// GET /api/v1/projects/:projectId/generation-runs
// Lists recent runs for the project so the UI can recover an active run after
// a refresh. Sorted newest-first.
export async function GET(
  _req: NextRequest,
  { params }: { params: { projectId: string } }
) {
  const requestId = newRequestId();
  try {
    const store = getGenerationRunStore();
    const runs = (await store.listRunsForProject(params.projectId)).sort(
      (a, b) => (a.createdAt < b.createdAt ? 1 : -1)
    );

    const res = jsonResponse({ runs }, requestId);
    // Status responses must be safe to poll repeatedly without caching.
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (err) {
    const res = errorResponse(err, requestId);
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
}
