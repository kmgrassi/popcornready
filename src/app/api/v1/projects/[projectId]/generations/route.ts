import { NextRequest } from "next/server";
import { resolveActor } from "@/lib/v1/actor";
import { createGenerationJob, runGenerationJob } from "@/lib/v1/generation";
import { errorResponse, jsonResponse } from "@/lib/v1/http";
import { requestId as newRequestId } from "@/lib/v1/ids";
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
  try {
    const store = getStore();
    const actor = resolveActor();
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
    });

    // Kick off execution without blocking the response. Failures are persisted
    // on the job record and surfaced through polling.
    if (job.status === "queued") {
      void runGenerationJob(store, job.id).catch(() => {});
    }

    return jsonResponse({ job }, requestId, 202);
  } catch (err) {
    return errorResponse(err, requestId);
  }
}
