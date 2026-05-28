import { NextRequest, NextResponse } from "next/server";
import {
  removeCharacterReference,
  updateCharacterReference,
} from "@/lib/store";
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

function parseRole(value: unknown): CharacterReferenceRole | undefined {
  const role = String(value || "");
  return ROLES.has(role) ? (role as CharacterReferenceRole) : undefined;
}

function parseQuality(value: unknown): CharacterReferenceQuality | undefined {
  const quality = String(value || "");
  return QUALITIES.has(quality) ? (quality as CharacterReferenceQuality) : undefined;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { characterId: string; referenceId: string } }
) {
  try {
    const body = await req.json();
    if (body.role !== undefined && !parseRole(body.role)) {
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
    const result = await updateCharacterReference(
      params.characterId,
      params.referenceId,
      {
        role: body.role !== undefined ? parseRole(body.role) : undefined,
        quality: body.quality !== undefined ? parseQuality(body.quality) : undefined,
        notes: body.notes !== undefined ? String(body.notes) : undefined,
      }
    );
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Character reference update failed" },
      { status: err?.message?.includes("not found") ? 404 : 500 }
    );
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { characterId: string; referenceId: string } }
) {
  const project = await removeCharacterReference(
    params.characterId,
    params.referenceId
  );
  return NextResponse.json({ project });
}
