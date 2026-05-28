import { NextRequest, NextResponse } from "next/server";
import {
  deleteCharacterProfile,
  getProject,
  updateCharacterProfile,
} from "@/lib/store";
import { CharacterProfileStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

const STATUSES = new Set(["draft", "ready", "archived"]);

function parseStatus(value: unknown): CharacterProfileStatus | undefined {
  const status = String(value || "");
  return STATUSES.has(status) ? (status as CharacterProfileStatus) : undefined;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { characterId: string } }
) {
  const project = await getProject();
  const character = project.characterProfiles?.find(
    (candidate) => candidate.id === params.characterId
  );
  if (!character) {
    return NextResponse.json({ error: "Character profile not found." }, { status: 404 });
  }

  return NextResponse.json({
    character,
    references:
      project.characterReferences?.filter(
        (reference) => reference.characterProfileId === params.characterId
      ) || [],
    project,
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { characterId: string } }
) {
  try {
    const body = await req.json();
    if (body.status !== undefined && !parseStatus(body.status)) {
      return NextResponse.json(
        { error: "status must be draft, ready, or archived." },
        { status: 400 }
      );
    }
    if (
      body.identityInvariants !== undefined &&
      !String(body.identityInvariants).trim()
    ) {
      return NextResponse.json(
        { error: "identityInvariants are required." },
        { status: 400 }
      );
    }
    const result = await updateCharacterProfile(params.characterId, {
      name: body.name !== undefined ? String(body.name) : undefined,
      description:
        body.description !== undefined ? String(body.description) : undefined,
      identityInvariants:
        body.identityInvariants !== undefined
          ? String(body.identityInvariants)
          : undefined,
      styleInvariants:
        body.styleInvariants !== undefined
          ? String(body.styleInvariants)
          : undefined,
      wardrobeInvariants:
        body.wardrobeInvariants !== undefined
          ? String(body.wardrobeInvariants)
          : undefined,
      negativePrompt:
        body.negativePrompt !== undefined ? String(body.negativePrompt) : undefined,
      status: body.status !== undefined ? parseStatus(body.status) : undefined,
    });
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Character update failed" },
      { status: err?.message?.includes("not found") ? 404 : 500 }
    );
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { characterId: string } }
) {
  const project = await deleteCharacterProfile(params.characterId);
  return NextResponse.json({ project });
}
