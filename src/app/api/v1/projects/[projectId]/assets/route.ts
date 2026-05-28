import { NextRequest } from "next/server";
import { registerAsset } from "@/lib/api/v1/assets";
import { handleMutation, handleRead } from "@/lib/api/v1/handler";
import { parsePagination, parseRegisterAsset } from "@/lib/api/v1/schemas";
import { listAssets } from "@/lib/api/v1/store";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: { projectId: string } }
) {
  return handleMutation(req, async ({ auth, body }) => {
    const input = parseRegisterAsset(body);
    const asset = await registerAsset(auth, params.projectId, input);
    return { status: 201, body: { asset } };
  });
}

export async function GET(
  req: NextRequest,
  { params }: { params: { projectId: string } }
) {
  return handleRead(req, async ({ auth, req }) => {
    const { limit, cursor } = parsePagination(req.nextUrl.searchParams);
    const { items, nextCursor } = await listAssets(
      auth.workspaceId,
      params.projectId,
      limit,
      cursor
    );
    return {
      status: 200,
      body: { assets: items, pagination: { limit, nextCursor } },
    };
  });
}
