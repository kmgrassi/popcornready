import { NextResponse } from "next/server";
import { authMode } from "@/lib/api/v1/auth";
import { newRequestId } from "@/lib/api/v1/ids";

export const dynamic = "force-dynamic";

export async function GET() {
  const requestId = newRequestId();
  return NextResponse.json(
    { status: "ok", authMode: authMode(), time: new Date().toISOString() },
    { headers: { "X-Request-Id": requestId } }
  );
}
