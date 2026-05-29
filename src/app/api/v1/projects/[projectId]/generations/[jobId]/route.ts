import { NextRequest } from "next/server";
import { ApiError } from "@/lib/v1/errors";
import { errorResponse, jsonResponse } from "@/lib/v1/http";
import { requestId as newRequestId } from "@/lib/v1/ids";
import { getStore } from "@/lib/v1/store";

export const dynamic = "force-dynamic";

// GET /api/v1/projects/:projectId/generations/:jobId
// Polls a generation job. On success the job result points to created
// timeline IDs.
export async function GET(
  _req: NextRequest,
  { params }: { params: { projectId: string; jobId: string } }
) {
  const requestId = newRequestId();
  try {
    const store = getStore();
    const job = await store.getJob(params.jobId);
    if (!job || job.projectId !== params.projectId || job.type !== "generation") {
      throw new ApiError("not_found", `Generation job not found: ${params.jobId}`);
    }
    return jsonResponse({ job }, requestId);
  } catch (err) {
    return errorResponse(err, requestId);
  }
}
