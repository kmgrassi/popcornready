import { NextRequest, NextResponse } from "next/server";
import { errorResponse, requireActor } from "@/lib/agent-api/http";
import { agentApiStore } from "@/lib/agent-api/jobs";
import { ApiError, requestId } from "@/lib/agent-api/runtime";

export const dynamic = "force-dynamic";

// GET /api/v1/projects/:projectId/artifacts/:artifactId
export async function GET(
  req: NextRequest,
  { params }: { params: { artifactId: string } }
) {
  const reqId = requestId();
  try {
    requireActor(req);
    const artifact = await agentApiStore.getArtifact(params.artifactId);
    if (!artifact) {
      throw new ApiError("artifact_not_found", 404, "Artifact not found.", {
        artifactId: params.artifactId,
      });
    }
    return NextResponse.json({ artifact });
  } catch (err) {
    return errorResponse(err, reqId);
  }
}
