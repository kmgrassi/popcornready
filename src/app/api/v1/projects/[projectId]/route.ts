import { NextRequest } from "next/server";
import { handleRead } from "@/lib/api/v1/handler";
import { getProject } from "@/lib/api/v1/store";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: { projectId: string } }
) {
  return handleRead(req, async ({ auth }) => {
    const project = await getProject(auth.workspaceId, params.projectId);
    return { status: 200, body: { project } };
  });
}
