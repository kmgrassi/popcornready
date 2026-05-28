import { NextRequest, NextResponse } from "next/server";
import { createCharacterProfile, getProject } from "@/lib/store";
import { CharacterProfileStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

const STATUSES = new Set(["draft", "ready", "archived"]);

function parseStatus(value: unknown): CharacterProfileStatus | undefined {
  const status = String(value || "");
  return STATUSES.has(status) ? (status as CharacterProfileStatus) : undefined;
}

export async function GET() {
  const project = await getProject();
  return NextResponse.json({
    characterProfiles: project.characterProfiles || [],
    characterReferences: project.characterReferences || [],
    project,
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const name = String(body.name || "").trim();
    const identityInvariants = String(body.identityInvariants || "").trim();

    if (!name) {
      return NextResponse.json({ error: "Character name is required." }, { status: 400 });
    }
    if (!identityInvariants) {
      return NextResponse.json(
        { error: "identityInvariants are required." },
        { status: 400 }
      );
    }
    if (body.status !== undefined && !parseStatus(body.status)) {
      return NextResponse.json(
        { error: "status must be draft, ready, or archived." },
        { status: 400 }
      );
    }

    const result = await createCharacterProfile({
      name,
      description: String(body.description || ""),
      identityInvariants,
      styleInvariants: body.styleInvariants
        ? String(body.styleInvariants)
        : undefined,
      wardrobeInvariants: body.wardrobeInvariants
        ? String(body.wardrobeInvariants)
        : undefined,
      negativePrompt: body.negativePrompt ? String(body.negativePrompt) : undefined,
      status: parseStatus(body.status),
    });

    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Character creation failed" },
      { status: 500 }
    );
  }
}
