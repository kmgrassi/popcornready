import { NextResponse } from "next/server";
import { getProject } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  const project = await getProject();
  return NextResponse.json({ project });
}
