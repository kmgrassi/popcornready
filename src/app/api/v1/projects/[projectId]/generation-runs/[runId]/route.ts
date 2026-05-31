import { NextRequest } from "next/server";

import { errorResponse, jsonResponse } from "@/lib/v1/http";
import { requestId as newRequestId } from "@/lib/v1/ids";
import {
  assemblePayload,
  getGenerationRunStore,
  requireRun,
} from "@/lib/v1/generation-runs";

export const dynamic = "force-dynamic";

// GET /api/v1/projects/:projectId/generation-runs/:runId
// Polls a single generation run. Returns the run, its stages (in order),
// stage items, and pointers to any completed result artifacts so the UI can
// progressively reveal generated work.
export async function GET(
  _req: NextRequest,
  { params }: { params: { projectId: string; runId: string } }
) {
  const requestId = newRequestId();
  try {
    const store = getGenerationRunStore();
    const payload = await assemblePayload(store, params.runId);
    const verified = requireRun(payload, params.runId, params.projectId);

    const res = jsonResponse(verified, requestId);
    // Status responses must be safe to poll repeatedly without caching.
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (err) {
    const res = errorResponse(err, requestId);
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
}
