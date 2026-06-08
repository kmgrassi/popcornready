// Per-beat keyframe generation + the sketch -> photoreal seeding bridge and the
// first-frame guardrail (Storyboard & Scenes, Part C; docs/scopes/storyboard-scenes.md).
//
// A beat's `beat_storyboard` sketch tile (the cheap pre-viz panel from PR2) can
// SEED the expensive photoreal `beat_keyframe`. The sketch conditions
// composition ONLY — framing, blocking, camera, character placement, pose — and
// is then RE-RENDERED fully photoreal. The pencil/marker linework must NOT
// survive into the keyframe: we pass the sketch as a structural REFERENCE image
// (composition conditioning) alongside a strong photoreal prompt, never as a
// high-strength img2img/img2video source that would keep the sketch look.
//
// GUARDRAIL: the image a clip opens on (its image-to-video first frame /
// `firstFrameAssetId`) is ALWAYS a photoreal `beat_keyframe`, NEVER a
// `beat_storyboard` sketch. `assertPhotorealFirstFrame` / `selectClipFirstFrame`
// enforce that at the single point where the first-frame asset is chosen.

import type { Beat } from "@popcorn/shared/types";
import type { Asset, AssetInputs, AssetRole } from "@popcorn/shared/assets/types";

// Image roles that are allowed to be a clip's literal first frame. A clip opens
// on a PHOTOREAL frame; the storyboard sketch is composition pre-viz only.
const FIRST_FRAME_ALLOWED_ROLES: ReadonlySet<AssetRole> = new Set<AssetRole>([
  "beat_keyframe",
  // A scene's establishing photoreal image and uploaded photoreal stills are
  // legitimate photoreal first frames too; a character_anchor is a real portrait.
  "scene_anchor",
  "character_anchor",
  "upload",
]);

// The sketch role that must NEVER reach a clip's first frame.
export const STORYBOARD_ROLE: AssetRole = "beat_storyboard";

export class FirstFrameGuardrailError extends Error {
  readonly assetId: string;
  readonly role: AssetRole;
  constructor(asset: Pick<Asset, "id" | "role">) {
    super(
      `First-frame guardrail: asset ${asset.id} has role "${asset.role}" and cannot seed a clip's first frame. ` +
        `The clip first frame must be a photoreal "beat_keyframe" — a "beat_storyboard" sketch is composition pre-viz only ` +
        `and must be re-rendered into a photoreal keyframe first.`
    );
    this.name = "FirstFrameGuardrailError";
    this.assetId = asset.id;
    this.role = asset.role;
  }
}

// THE GUARDRAIL. Assert that the image chosen to be a clip's first frame is a
// photoreal frame and, specifically, never a `beat_storyboard` sketch. Returns
// the asset (narrowed) so callers can use it inline as a guard.
export function assertPhotorealFirstFrame(asset: Asset): Asset {
  if (asset.role === STORYBOARD_ROLE) {
    throw new FirstFrameGuardrailError(asset);
  }
  if (!FIRST_FRAME_ALLOWED_ROLES.has(asset.role)) {
    throw new FirstFrameGuardrailError(asset);
  }
  return asset;
}

export function isAllowedFirstFrameRole(role: AssetRole): boolean {
  return role !== STORYBOARD_ROLE && FIRST_FRAME_ALLOWED_ROLES.has(role);
}

// Resolve the asset that will be a clip's first frame, with the guardrail
// applied. This is the SINGLE point where a clip's `firstFrameAssetId` is chosen
// from a candidate (e.g. the active `beat_keyframe` selection for a beat). A
// `beat_storyboard` candidate is rejected here — it can never reach the clip.
export function selectClipFirstFrame(candidate: Asset): Asset {
  return assertPhotorealFirstFrame(candidate);
}

// Build the photoreal keyframe prompt. When a sketch seeds it, the prompt makes
// the contract explicit to the image model: the reference sketch dictates
// composition/framing/blocking ONLY and the output must be a fully photoreal,
// live-action frame with NO trace of the sketch's pencil/line aesthetic.
export function buildKeyframePrompt(input: {
  beat: Beat;
  beatIndex: number;
  totalBeats: number;
  style: string;
  aspectRatio: string;
  // Identity/wardrobe/negative anchors for the recurring character, if any.
  characterInvariants?: { identity?: string; wardrobe?: string; negative?: string };
  // True when a `beat_storyboard` sketch is provided as a composition seed.
  sketchSeeded: boolean;
}): string {
  const lines: string[] = [];

  if (input.sketchSeeded) {
    lines.push(
      "You are given a ROUGH STORYBOARD SKETCH as a composition reference and, when present, a photographic character reference.",
      "Use the sketch ONLY to copy the composition: framing, camera angle, shot size, subject placement/blocking, and pose.",
      "RE-RENDER the scene as a brand-new, fully PHOTOREALISTIC live-action film still.",
      "Do NOT reproduce the sketch's pencil/marker linework, paper texture, hand-drawn lines, grayscale, flat shading, or any drawn/illustrated look — none of the sketch aesthetic may survive into the output.",
      "The result must look like a real photograph/film frame, not a sketch, drawing, illustration, painting, or storyboard panel."
    );
  } else {
    lines.push(
      "Create a NEW cinematic PHOTOREALISTIC live-action film still."
    );
  }

  if (input.characterInvariants) {
    lines.push("[CHARACTER INVARIANTS]");
    if (input.characterInvariants.identity) lines.push(input.characterInvariants.identity);
    if (input.characterInvariants.wardrobe) lines.push(input.characterInvariants.wardrobe);
    if (input.characterInvariants.negative) lines.push(input.characterInvariants.negative);
    lines.push(
      "Keep the SAME character from the photographic reference (same face, hair, build, and wardrobe anchors)."
    );
  }

  lines.push(
    "[SHOT]",
    `Beat ${input.beatIndex + 1} of ${input.totalBeats} — ${input.beat.name}: ${input.beat.intent}.`,
    `${input.aspectRatio} aspect-ratio framing.`,
    `Visual style: ${input.style}.`,
    "Photorealistic live-action, cinematic lighting, strong composition, depth and subject/background separation.",
    "No text, logos, captions, watermarks, sketch lines, or storyboard annotations."
  );

  return lines.join(" ");
}

// Assemble the provider reference paths for a keyframe. The character anchor (a
// photoreal portrait) comes FIRST so it dominates likeness; the storyboard sketch
// is appended as a lower-priority STRUCTURAL/composition reference — never the
// sole or first reference, so the model treats it as layout guidance, not a
// source image to stylistically copy.
export function keyframeReferencePaths(input: {
  characterReferencePath?: string;
  storyboardSketchPath?: string;
}): string[] {
  const paths: string[] = [];
  if (input.characterReferencePath) paths.push(input.characterReferencePath);
  if (input.storyboardSketchPath) paths.push(input.storyboardSketchPath);
  return paths;
}

// Provenance input edges for a generated keyframe. Records the seeding sketch as
// `storyboardAssetId` (Part C provenance) plus the beat and any character anchor.
export function keyframeProvenanceInputs(input: {
  beatId?: string;
  anchorAssetId?: string;
  storyboardAssetId?: string;
}): AssetInputs {
  return {
    ...(input.beatId ? { beatId: input.beatId } : {}),
    ...(input.anchorAssetId ? { anchorIds: [input.anchorAssetId] } : {}),
    ...(input.storyboardAssetId ? { storyboardAssetId: input.storyboardAssetId } : {}),
  };
}
