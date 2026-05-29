import { NextRequest } from "next/server";
import { handleRead } from "@/lib/api/v1/handler";
import { getAsset } from "@/lib/api/v1/store";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: { projectId: string; assetId: string } }
) {
  return handleRead(req, async ({ auth }) => {
    const asset = await getAsset(auth.workspaceId, params.projectId, params.assetId);
    return { status: 200, body: { asset } };
  });
}
