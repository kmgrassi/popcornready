import { NextRequest } from "next/server";
import { handleMutation, handleRead } from "@/lib/api/v1/handler";
import { parseBrief, parsePagination } from "@/lib/api/v1/schemas";
import { createBriefVersion, listBriefVersions } from "@/lib/api/v1/store";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: { projectId: string } }
) {
  return handleMutation(req, async ({ auth, body }) => {
    const brief = parseBrief(body, "");
    const { briefVersion } = await createBriefVersion(
      auth.workspaceId,
      params.projectId,
      brief
    );
    return { status: 201, body: { briefVersion } };
  });
}

export async function GET(
  req: NextRequest,
  { params }: { params: { projectId: string } }
) {
  return handleRead(req, async ({ auth, req }) => {
    const { limit, cursor } = parsePagination(req.nextUrl.searchParams);
    const { items, nextCursor } = await listBriefVersions(
      auth.workspaceId,
      params.projectId,
      limit,
      cursor
    );
    return {
      status: 200,
      body: { briefVersions: items, pagination: { limit, nextCursor } },
    };
  });
}
