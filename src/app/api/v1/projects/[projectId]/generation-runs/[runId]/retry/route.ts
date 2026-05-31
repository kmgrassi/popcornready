import { NextRequest } from "next/server";

import { ApiError } from "@/lib/v1/errors";
import { errorResponse } from "@/lib/v1/http";
import { requestId as newRequestId } from "@/lib/v1/ids";
import {
  assemblePayload,
  getGenerationRunStore,
  requireRun,
} from "@/lib/v1/generation-runs";

export const dynamic = "force-dynamic";

// POST /api/v1/projects/:projectId/generation-runs/:runId/retry
// Retries failed retryable stages or items when the backend supports it. PR 4
// returns a 501 "not_implemented" envelope until PR 3 wires retry semantics.
// The run is still looked up so callers get a 404 for unknown IDs and a
// consistent "supported soon" message for known ones.
export async function POST(
  _req: NextRequest,
  { params }: { params: { projectId: string; runId: string } }
) {
  const requestId = newRequestId();
  try {
    const store = getGenerationRunStore();
    const payload = await assemblePayload(store, params.runId);
    requireRun(payload, params.runId, params.projectId);

    throw new ApiError(
      "not_implemented",
      "Retry is not supported for generation runs yet.",
      { supported: false, action: "retry" }
    );
  } catch (err) {
    return errorResponse(err, requestId);
  }
}
