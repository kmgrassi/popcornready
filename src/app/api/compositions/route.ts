import { NextRequest, NextResponse } from "next/server";
import {
  findCompositionByIdempotencyKey,
  getComposition,
  getProject,
  saveComposition,
} from "@/lib/store";
import { planCompositionBeats } from "@/lib/agent/composition";
import { mergeStoryContext } from "@/lib/story-context";
import {
  assertCompositionConstraints,
  buildCompositionPlan,
  NarrationProposal,
  parseCompositionMode,
  resolveAssetPolicy,
  resolveProviderDefaults,
} from "@/lib/composition";
import { AspectRatio, Clip, StoryContext } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Client-input problems map to 400; malformed planner output maps to 500.
const BAD_REQUEST_MARKERS = [
  "Unsupported composition mode",
  "references unknown asset",
  "requires beat",
  "requires at least one existing",
  "asset_driven requires existing assets",
  "maxGenerated",
  "narration references unknown",
  "Narration references unknown",
  "is not an audio asset",
  "Provide a creative goal",
  "omits required asset",
  "uses an avoided asset",
];

function statusForError(message: string): number {
  return BAD_REQUEST_MARKERS.some((m) => message.includes(m)) ? 400 : 500;
}

type BriefNarration = {
  mode?: "none" | "generate" | "provided_text" | "provided_asset";
  script?: string;
  audioAssetId?: string;
};

function narrationModeFromBrief(
  narration: BriefNarration | undefined
): NarrationProposal["mode"] {
  switch (narration?.mode) {
    case "generate":
      return "generate";
    case "provided_text":
    case "provided_asset":
      return "provided";
    default:
      return "none";
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const idempotencyKey =
      req.headers.get("idempotency-key") ||
      (body.idempotencyKey ? String(body.idempotencyKey) : "");

    if (idempotencyKey) {
      const existing = await findCompositionByIdempotencyKey(idempotencyKey);
      if (existing) {
        const stored = await getComposition(existing.id);
        return NextResponse.json(
          { composition: existing, jobs: stored?.jobs || [] },
          { status: 200 }
        );
      }
    }

    const mode = parseCompositionMode(body.mode);
    const goal = String(body.goal || "").trim();
    if (!goal) {
      throw new Error("Provide a creative goal or brief.");
    }
    const targetLengthSec = Number(body.targetLengthSec) || 30;
    const style = String(body.style || "fast-paced social video");
    const aspectRatio = (body.aspectRatio || "9:16") as AspectRatio;
    const storyContext = mergeStoryContext(body.storyContext as StoryContext);
    const briefVersionId = body.briefVersionId
      ? String(body.briefVersionId)
      : undefined;

    const project = await getProject();
    const assetById = new Map(project.clips.map((c: Clip) => [c.id, c]));

    const mustUseAssetIds = stringArray(body.constraints?.mustUseAssetIds);
    const avoidAssetIds = stringArray(body.constraints?.avoidAssetIds);
    if (mode !== "prompt_only") {
      for (const id of [...mustUseAssetIds, ...avoidAssetIds]) {
        if (!assetById.has(id)) {
          throw new Error(`Constraint references unknown asset: ${id}.`);
        }
      }
    }
    const visualClipCount = project.clips.filter(
      (c: Clip) => (c.kind || "video") !== "audio"
    ).length;
    if (mode === "asset_driven" && visualClipCount === 0) {
      throw new Error(
        "Composition mode asset_driven requires existing assets, but the project has none."
      );
    }

    const briefNarration = body.narration as BriefNarration | undefined;
    const requestedNarrationMode = narrationModeFromBrief(briefNarration);

    const planned = await planCompositionBeats({
      goal,
      targetLengthSec,
      style,
      aspectRatio,
      mode,
      storyContext,
      clips: project.clips,
      mustUseAssetIds,
      avoidAssetIds,
      narration: {
        mode: requestedNarrationMode,
        script: briefNarration?.script,
      },
    });

    const narration: NarrationProposal = {
      mode: requestedNarrationMode,
      script: planned.narration.script || briefNarration?.script,
      audioAssetId:
        briefNarration?.mode === "provided_asset"
          ? briefNarration.audioAssetId
          : undefined,
    };

    const { composition, jobs } = buildCompositionPlan({
      projectId: project.id,
      mode,
      beats: planned.beats,
      availableAssets: project.clips,
      narration,
      providers: resolveProviderDefaults(body.providerPolicy),
      assetPolicy: resolveAssetPolicy(body.assetPolicy),
      briefVersionId,
      idempotencyKey: idempotencyKey || undefined,
    });

    // Verify the planner honored the caller's explicit asset constraints
    // before persisting; the prompt alone does not guarantee compliance.
    assertCompositionConstraints(composition, { mustUseAssetIds, avoidAssetIds });

    await saveComposition(composition, jobs);
    return NextResponse.json({ composition, jobs }, { status: 201 });
  } catch (err: any) {
    const message = err?.message || "Composition planning failed";
    return NextResponse.json(
      { error: message },
      { status: statusForError(message) }
    );
  }
}
