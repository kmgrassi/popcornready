import { NextRequest } from "next/server";
import { handleMutation } from "@/lib/api/v1/handler";
import { createGeneratedAsset } from "@/lib/api/v1/generated-assets";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

// POST /api/v1/projects/:projectId/generated-assets
// Generates an image/video/audio asset and persists it as a normal project
// asset with provenance. Returns the asset_generation job (202); poll the
// GET endpoint for the result. Idempotency-Key is honored by handleMutation.
export async function POST(
  req: NextRequest,
  { params }: { params: { projectId: string } }
) {
  return handleMutation(req, ({ auth, body }) =>
    createGeneratedAsset({ auth, projectId: params.projectId, body })
  );
}
