import { NextRequest } from "next/server";
import { ApiError } from "@/lib/v1/errors";
import { errorResponse, jsonResponse } from "@/lib/v1/http";
import { requestId as newRequestId } from "@/lib/v1/ids";
import { createLogger } from "@/lib/v1/logger";
import { redactMessage } from "@/lib/v1/redact";
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
  const start = Date.now();
  const logger = createLogger({
    requestId,
    projectId: params.projectId,
    jobId: params.jobId,
    jobType: "generation",
  });
  logger.debug("http.request.started", {
    method: "GET",
    route: "/api/v1/projects/:projectId/generations/:jobId",
  });
  try {
    const store = getStore();
    const job = await store.getJob(params.jobId);
    if (!job || job.projectId !== params.projectId || job.type !== "generation") {
      throw new ApiError("not_found", `Generation job not found: ${params.jobId}`);
    }
    logger.debug("http.request.finished", {
      status: 200,
      jobStatus: job.status,
      durationMs: Date.now() - start,
    });
    return jsonResponse({ job }, requestId);
  } catch (err) {
    const message = redactMessage(err instanceof Error ? err.message : String(err));
    logger.warn("http.request.failed", {
      durationMs: Date.now() - start,
      error: { message },
    });
    if (err instanceof ApiError) {
      return errorResponse(new ApiError(err.code, message, err.details), requestId);
    }
    return errorResponse(new ApiError("internal_error", message), requestId);
  }
}
