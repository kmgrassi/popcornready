import { NextRequest } from "next/server";

import { errorResponse, jsonResponse } from "@/lib/v1/http";
import { requestId as newRequestId } from "@/lib/v1/ids";
import {
  approveReviewGate,
  assemblePayload,
  getGenerationRunStore,
  requireRun,
} from "@/lib/v1/generation-runs";

export const dynamic = "force-dynamic";

// POST /api/v1/projects/:projectId/generation-runs/:runId/approve
// Clears the current review gate and advances the run pointer to the next
// queued stage. Duplicate approvals on active runs are idempotent no-ops.
export async function POST(
  _req: NextRequest,
  { params }: { params: { projectId: string; runId: string } }
) {
  const requestId = newRequestId();
  try {
    const store = getGenerationRunStore();
    const payload = await assemblePayload(store, params.runId);
    requireRun(payload, params.runId, params.projectId);

    const approved = await approveReviewGate(store, params.runId);
    return jsonResponse(approved, requestId);
  } catch (err) {
    return errorResponse(err, requestId);
  }
}
