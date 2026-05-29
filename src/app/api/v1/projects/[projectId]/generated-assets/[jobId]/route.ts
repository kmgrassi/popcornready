import { NextRequest } from "next/server";
import { handleRead } from "@/lib/api/v1/handler";
import { getGeneratedAssetJob } from "@/lib/api/v1/generated-assets";

export const dynamic = "force-dynamic";

// GET /api/v1/projects/:projectId/generated-assets/:jobId
// Polls an asset_generation job. On success the result points to the created
// asset ID, which is then readable through the standard asset API.
export async function GET(
  req: NextRequest,
  { params }: { params: { projectId: string; jobId: string } }
) {
  return handleRead(req, ({ auth }) =>
    getGeneratedAssetJob({
      auth,
      projectId: params.projectId,
      jobId: params.jobId,
    })
  );
}
