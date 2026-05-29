import { NextRequest, NextResponse } from "next/server";
import {
  errorResponse,
  getIdempotencyKey,
  loadProject,
  requireActor,
} from "@/lib/agent-api/http";
import { agentApiStore } from "@/lib/agent-api/jobs";
import { ApiError, requestId, toErrorEnvelope } from "@/lib/agent-api/runtime";
import { runRevisionJob } from "@/lib/agent-api/workers";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// POST /api/v1/projects/:projectId/timelines/:timelineId/revisions
// Create a revision job. The worker runs inline, so the returned job is already
// terminal; agents can still poll the GET endpoint.
export async function POST(
  req: NextRequest,
  { params }: { params: { projectId: string; timelineId: string } }
) {
  const reqId = requestId();
  try {
    requireActor(req);

    const body = await req.json().catch(() => ({}));
    const message = String(body?.message ?? "").trim();
    if (!message) {
      throw new ApiError("invalid_request", 400, "A revision `message` is required.");
    }

    const { job, created } = await agentApiStore.createOrGetJob({
      type: "revision",
      projectId: params.projectId,
      idempotencyKey: getIdempotencyKey(req),
    });
    if (!created) {
      return NextResponse.json({ job }, { status: 200 });
    }

    try {
      await agentApiStore.setStep(job.id, "planning_timeline");
      const project = await loadProject(params.projectId);
      const result = await runRevisionJob({
        project,
        timelineId: params.timelineId,
        message,
      });
      const finished = await agentApiStore.succeed(job.id, result);
      return NextResponse.json({ job: finished }, { status: 201 });
    } catch (workerErr) {
      const { body: errBody } = toErrorEnvelope(workerErr, reqId);
      await agentApiStore.fail(job.id, errBody.error);
      return errorResponse(workerErr, reqId);
    }
  } catch (err) {
    return errorResponse(err, reqId);
  }
}
