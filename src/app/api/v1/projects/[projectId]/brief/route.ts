import { NextRequest } from "next/server";
import { ApiError } from "@/lib/api/v1/errors";
import { handleMutation, handleRead } from "@/lib/api/v1/handler";
import { parseBrief } from "@/lib/api/v1/schemas";
import { getProject, setBrief } from "@/lib/api/v1/store";

export const dynamic = "force-dynamic";

export async function PUT(
  req: NextRequest,
  { params }: { params: { projectId: string } }
) {
  return handleMutation(req, async ({ auth, body }) => {
    const brief = parseBrief(body, "");
    const project = await setBrief(auth.workspaceId, params.projectId, brief);
    return { status: 200, body: { project } };
  });
}

export async function GET(
  req: NextRequest,
  { params }: { params: { projectId: string } }
) {
  return handleRead(req, async ({ auth }) => {
    const project = await getProject(auth.workspaceId, params.projectId);
    if (!project.brief) {
      throw new ApiError("brief_missing", "This project has no brief yet.");
    }
    return {
      status: 200,
      body: { brief: project.brief, currentBriefVersionId: project.currentBriefVersionId },
    };
  });
}
