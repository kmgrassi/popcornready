import { NextRequest } from "next/server";

import { errorResponse, jsonResponse } from "@/lib/v1/http";
import { requestId as newRequestId } from "@/lib/v1/ids";
import {
  assemblePayload,
  getGenerationRunStore,
  rejectReviewGate,
  requireRun,
} from "@/lib/v1/generation-runs";

export const dynamic = "force-dynamic";

// POST /api/v1/projects/:projectId/generation-runs/:runId/reject
// Reuses the retry path semantics for an awaiting-review gate: the gated stage
// is reset for regeneration (stale artifacts/items dropped) and the gate is
// cleared, so the stage must actually re-run before it can re-pause for review.
export async function POST(
  req: NextRequest,
  { params }: { params: { projectId: string; runId: string } }
) {
  const requestId = newRequestId();
  try {
    const store = getGenerationRunStore();
    const payload = await assemblePayload(store, params.runId);
    requireRun(payload, params.runId, params.projectId);

    let body: unknown = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const rejected = await rejectReviewGate(store, params.runId, body);
    return jsonResponse(rejected, requestId);
  } catch (err) {
    return errorResponse(err, requestId);
  }
}
