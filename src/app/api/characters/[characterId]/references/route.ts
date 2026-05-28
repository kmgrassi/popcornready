import { NextRequest, NextResponse } from "next/server";
import { attachCharacterReference, getProject } from "@/lib/store";
import { CharacterReferenceQuality, CharacterReferenceRole } from "@/lib/types";

export const dynamic = "force-dynamic";

const ROLES = new Set([
  "front_portrait",
  "three_quarter",
  "profile",
  "full_body",
  "style",
  "wardrobe",
  "hero_frame",
]);
const QUALITIES = new Set(["candidate", "approved", "rejected"]);

function parseRole(value: unknown): CharacterReferenceRole | null {
  const role = String(value || "");
  return ROLES.has(role) ? (role as CharacterReferenceRole) : null;
}

function parseQuality(value: unknown): CharacterReferenceQuality | undefined {
  const quality = String(value || "");
  return QUALITIES.has(quality) ? (quality as CharacterReferenceQuality) : undefined;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { characterId: string } }
) {
  const project = await getProject();
  return NextResponse.json({
    references:
      project.characterReferences?.filter(
        (reference) => reference.characterProfileId === params.characterId
      ) || [],
    project,
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: { characterId: string } }
) {
  try {
    const body = await req.json();
    const assetId = String(body.assetId || "").trim();
    const role = parseRole(body.role);

    if (!assetId) {
      return NextResponse.json({ error: "assetId is required." }, { status: 400 });
    }
    if (!role) {
      return NextResponse.json(
        { error: "role must be a supported character reference role." },
        { status: 400 }
      );
    }
    if (body.quality !== undefined && !parseQuality(body.quality)) {
      return NextResponse.json(
        { error: "quality must be candidate, approved, or rejected." },
        { status: 400 }
      );
    }

    const result = await attachCharacterReference(params.characterId, {
      assetId,
      role,
      quality: parseQuality(body.quality),
      notes: body.notes ? String(body.notes) : undefined,
    });
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Character reference creation failed" },
      { status: err?.message?.includes("not found") ? 404 : 500 }
    );
  }
}
