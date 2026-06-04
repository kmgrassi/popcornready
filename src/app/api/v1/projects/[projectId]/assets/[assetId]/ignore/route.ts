import { NextRequest } from "next/server";
import { updateAssetContext } from "@/lib/api/v1/assets";
import { handleMutation } from "@/lib/api/v1/handler";
import { getAsset } from "@/lib/api/v1/store";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: { projectId: string; assetId: string } }
) {
  return handleMutation(req, async ({ auth }) => {
    const current = await getAsset(auth.workspaceId, params.projectId, params.assetId);
    const asset = await updateAssetContext(auth, params.projectId, params.assetId, {
      userContext: {
        ...(current.userContext ?? {}),
        avoid: true,
      },
    });
    return { status: 200, body: { asset } };
  });
}
