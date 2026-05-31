import { NextRequest } from "next/server";

import { errorResponse, jsonResponse } from "@/lib/v1/http";
import { requestId as newRequestId } from "@/lib/v1/ids";
import {
  assemblePayload,
  approveReviewGate,
  getGenerationRunStore,
  requireRun,
} from "@/lib/v1/generation-runs";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: { projectId: string; runId: string } }
) {
  const requestId = newRequestId();
  try {
    const store = getGenerationRunStore();
    requireRun(
      await assemblePayload(store, params.runId),
      params.runId,
      params.projectId
    );
    const payload = await approveReviewGate(store, params.runId);
    const verified = requireRun(payload, params.runId, params.projectId);

    const res = jsonResponse(verified, requestId);
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (err) {
    const res = errorResponse(err, requestId);
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
}
