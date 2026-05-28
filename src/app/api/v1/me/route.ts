import { NextRequest } from "next/server";
import { handleRead } from "@/lib/api/v1/handler";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return handleRead(req, async ({ auth }) => ({
    status: 200,
    body: {
      actor: auth.actor,
      workspaceId: auth.workspaceId,
      authMode: auth.mode,
      isLocal: auth.isLocal,
    },
  }));
}
