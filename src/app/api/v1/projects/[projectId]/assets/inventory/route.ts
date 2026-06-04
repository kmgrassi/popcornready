import { NextRequest } from "next/server";
import { inventoryAssets } from "@/lib/api/v1/assets";
import { handleMutation } from "@/lib/api/v1/handler";
import { parseAssetInventory } from "@/lib/api/v1/schemas";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: { projectId: string } }
) {
  return handleMutation(req, async ({ auth, body }) => {
    const input = parseAssetInventory(body);
    const report = await inventoryAssets(auth, params.projectId, input);
    return { status: 200, body: { report } };
  });
}
