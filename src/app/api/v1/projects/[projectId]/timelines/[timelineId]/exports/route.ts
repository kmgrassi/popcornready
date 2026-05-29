import { NextRequest, NextResponse } from "next/server";
import {
  errorResponse,
  getIdempotencyKey,
  loadProject,
  requireActor,
} from "@/lib/agent-api/http";
import { agentApiStore } from "@/lib/agent-api/jobs";
import { requestId, toErrorEnvelope } from "@/lib/agent-api/runtime";
import { ExportOptions, runExportJob } from "@/lib/agent-api/workers";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

// POST /api/v1/projects/:projectId/timelines/:timelineId/exports
// Create an export job. PR6 emits a pending_render artifact; the actual MP4
// render is deferred to PR5 (see runExportJob).
export async function POST(
  req: NextRequest,
  { params }: { params: { projectId: string; timelineId: string } }
) {
  const reqId = requestId();
  try {
    requireActor(req);

    const body = await req.json().catch(() => ({}));
    const options: ExportOptions = {
      format: typeof body?.format === "string" ? body.format : undefined,
      quality: typeof body?.quality === "string" ? body.quality : undefined,
      audioAssetIds: Array.isArray(body?.audioAssetIds)
        ? body.audioAssetIds.filter((id: unknown) => typeof id === "string")
        : undefined,
      durationPolicy:
        typeof body?.durationPolicy === "string" ? body.durationPolicy : undefined,
      maxDeltaSec:
        typeof body?.maxDeltaSec === "number" ? body.maxDeltaSec : undefined,
    };

    const { job, created } = await agentApiStore.createOrGetJob({
      type: "export",
      projectId: params.projectId,
      idempotencyKey: getIdempotencyKey(req),
    });
    if (!created) {
      return NextResponse.json({ job }, { status: 200 });
    }

    try {
      await agentApiStore.setStep(job.id, "rendering_export");
      const project = await loadProject(params.projectId);
      const { artifact } = runExportJob({
        project,
        timelineId: params.timelineId,
        options,
      });
      await agentApiStore.saveArtifact(artifact);
      const finished = await agentApiStore.succeed(job.id, {
        artifactId: artifact.id,
      });
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
