import { NextRequest } from "next/server";
import { updateAssetContext } from "@/lib/api/v1/assets";
import { handleMutation } from "@/lib/api/v1/handler";
import { createJob } from "@/lib/api/v1/jobs";
import { parseAnalyzeAsset } from "@/lib/api/v1/schemas";
import { getAsset } from "@/lib/api/v1/store";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: { projectId: string; assetId: string } }
) {
  return handleMutation(req, async ({ auth, body }) => {
    const input = parseAnalyzeAsset(body);
    const asset = await getAsset(auth.workspaceId, params.projectId, params.assetId);
    const job = await createJob({
      workspaceId: auth.workspaceId,
      projectId: params.projectId,
      type: "asset_analysis",
      status: "queued",
      progress: {
        currentStep: input.regenerate ? "regenerate_analysis" : "analyze_asset",
        percent: 0,
      },
      result: {
        assetIds: [asset.id],
        regenerate: input.regenerate ?? false,
        analysisOptions: input.analysisOptions ?? {},
      },
      error: null,
    });

    await updateAssetContext(auth, params.projectId, params.assetId, {
      agentContext: {
        summary: input.regenerate
          ? "Analysis regeneration queued."
          : "Analysis queued.",
        mediaType: asset.kind,
        subjects: [],
        likelyUses: [],
        cautions: [],
        confidence: "low",
        sampledAssetIds: [],
        model: { provider: "pending" },
      },
    });

    return { status: 202, body: { job } };
  });
}
