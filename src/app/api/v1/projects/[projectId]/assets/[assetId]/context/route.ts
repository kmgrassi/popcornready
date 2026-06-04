import { NextRequest } from "next/server";
import { updateAssetContext } from "@/lib/api/v1/assets";
import { handleMutation } from "@/lib/api/v1/handler";
import { parseUpdateAssetContext } from "@/lib/api/v1/schemas";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: { projectId: string; assetId: string } }
) {
  return handleMutation(req, async ({ auth, body }) => {
    const input = parseUpdateAssetContext(body);
    const asset = await updateAssetContext(auth, params.projectId, params.assetId, input);
    return { status: 200, body: { asset } };
  });
}
