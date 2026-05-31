import { NextRequest } from "next/server";
import { ApiError } from "@/lib/v1/errors";
import { resolveActor } from "@/lib/v1/actor";
import { createGenerationJob, runGenerationJob } from "@/lib/v1/generation";
import { errorResponse, jsonResponse } from "@/lib/v1/http";
import { requestId as newRequestId } from "@/lib/v1/ids";
import { createLogger } from "@/lib/v1/logger";
import { redactMessage } from "@/lib/v1/redact";
import { getStore } from "@/lib/v1/store";
import { GenerationRequest } from "@/lib/v1/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// POST /api/v1/projects/:projectId/generations
// Validates the request, creates a generation job, and returns 202. The job
// runs in-process (v1 execution model); clients poll the GET endpoint.
export async function POST(
  req: NextRequest,
  { params }: { params: { projectId: string } }
) {
  const requestId = newRequestId();
  const start = Date.now();
  const actor = resolveActor();
  const logger = createLogger({
    requestId,
    workspaceId: actor.workspaceId,
    projectId: params.projectId,
    jobType: "generation",
  });
  logger.info("http.request.started", {
    method: "POST",
    route: "/api/v1/projects/:projectId/generations",
  });
  try {
    const store = getStore();
    const idempotencyKey = req.headers.get("Idempotency-Key") || undefined;

    let body: GenerationRequest;
    try {
      body = (await req.json()) as GenerationRequest;
    } catch {
      body = {};
    }

    const job = await createGenerationJob({
      store,
      actor,
      projectId: params.projectId,
      body,
      idempotencyKey,
      requestId,
      logger,
    });

    // Kick off execution without blocking the response. Failures are persisted
    // on the job record and surfaced through polling. The background runner
    // inherits the request's correlation IDs through the job record.
    if (job.status === "queued") {
      void runGenerationJob(store, job.id).catch((err) => {
        logger.error("job.run.crashed", {
          jobId: job.id,
          error: { message: redactMessage(err instanceof Error ? err.message : String(err)) },
        });
      });
    }

    logger.info("http.request.finished", {
      jobId: job.id,
      status: 202,
      durationMs: Date.now() - start,
    });
    return jsonResponse({ job }, requestId, 202);
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
