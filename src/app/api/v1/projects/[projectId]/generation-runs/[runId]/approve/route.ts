import { NextRequest } from "next/server";

import { errorResponse, jsonResponse } from "@/lib/v1/http";
import { requestId as newRequestId } from "@/lib/v1/ids";
import {
  approveGenerationRunGate,
  getGenerationRunStore,
} from "@/lib/v1/generation-runs";

export const dynamic = "force-dynamic";

// POST /api/v1/projects/:projectId/generation-runs/:runId/approve
// Clears the current review gate, marks the gated stage reviewed, and resumes
// the run at the next stage. Duplicate approvals after the gate has already
// cleared are a no-op for active runs; terminal runs return an invalid-state
// envelope.
export async function POST(
  _req: NextRequest,
  { params }: { params: { projectId: string; runId: string } }
) {
  const requestId = newRequestId();
  try {
    const payload = await approveGenerationRunGate({
      store: getGenerationRunStore(),
      projectId: params.projectId,
      runId: params.runId,
    });

    const res = jsonResponse(payload, requestId);
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (err) {
    const res = errorResponse(err, requestId);
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
}
