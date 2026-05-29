import { NextRequest, NextResponse } from "next/server";
import { getComposition } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: { compositionId: string } }
) {
  const result = await getComposition(params.compositionId);
  if (!result) {
    return NextResponse.json(
      { error: `Composition not found: ${params.compositionId}` },
      { status: 404 }
    );
  }
  return NextResponse.json({
    composition: result.composition,
    jobs: result.jobs,
  });
}
