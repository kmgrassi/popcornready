import { NextRequest } from "next/server";
import { handleMutation, handleRead } from "@/lib/api/v1/handler";
import { parseCreateProject, parsePagination } from "@/lib/api/v1/schemas";
import { createProject, listProjects } from "@/lib/api/v1/store";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  return handleMutation(req, async ({ auth, body }) => {
    const input = parseCreateProject(body);
    const { project } = await createProject({
      workspaceId: auth.workspaceId,
      name: input.name,
      brief: input.brief,
    });
    return { status: 201, body: { project } };
  });
}

export async function GET(req: NextRequest) {
  return handleRead(req, async ({ auth, req }) => {
    const { limit, cursor } = parsePagination(req.nextUrl.searchParams);
    const { items, nextCursor } = await listProjects(auth.workspaceId, limit, cursor);
    return {
      status: 200,
      body: { projects: items, pagination: { limit, nextCursor } },
    };
  });
}
