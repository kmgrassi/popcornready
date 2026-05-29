import { NextRequest, NextResponse } from "next/server";
import { errorResponse, requireActor } from "@/lib/agent-api/http";
import { agentApiStore } from "@/lib/agent-api/jobs";
import { ApiError, requestId } from "@/lib/agent-api/runtime";

export const dynamic = "force-dynamic";

// GET /api/v1/projects/:projectId/timelines/:timelineId/revisions/:jobId
export async function GET(
  req: NextRequest,
  { params }: { params: { jobId: string } }
) {
  const reqId = requestId();
  try {
    requireActor(req);
    const job = await agentApiStore.getJob(params.jobId);
    if (!job || job.type !== "revision") {
      throw new ApiError("job_not_found", 404, "Revision job not found.", {
        jobId: params.jobId,
      });
    }
    return NextResponse.json({ job });
  } catch (err) {
    return errorResponse(err, reqId);
  }
}
