import { promises as fs } from "fs";
import path from "path";

import { providerFor } from "@/lib/generative/providers";
import type { Beat, Clip } from "@/lib/types";
import type { CharacterGenerationContext } from "@/lib/generative/types";
import { oneShotCharacterBinding } from "@/lib/oneshot/character-reference";

export type VideoProvider = "openai" | "gemini" | "runway" | "ltx";

// A reference anchor resolved to its generated helper image, ready to seed a
// per-beat keyframe.
export interface ResolvedAnchor {
  id: string;
  subject: string;
  imagePath: string;
}

const GENERATED_DIR = path.join(process.cwd(), "public", "generated");
const KEYFRAME_DIR = path.join(GENERATED_DIR, "keyframes");
const ANCHOR_DIR = path.join(GENERATED_DIR, "anchors");

function newId(prefix: string): string {
  return `${prefix}_` + Math.random().toString(36).slice(2, 10);
}

export async function generateBeatClip(input: {
  provider: VideoProvider;
  prompt: string;
  description: string;
  size: string;
  displaySec: number;
  // Provider-normalized at the request layer; accept any number so both the
  // one-shot route and the v1 runs pipeline can pass their clamped durations.
  seconds?: number;
  characterContext?: CharacterGenerationContext;
  // When set (per-beat keyframe), this image is the image-to-video first frame
  // instead of the static character hero portrait — so every shot opens on a
  // purpose-built frame rather than the identical portrait.
  firstFramePath?: string;
}): Promise<Clip> {
  const provider = providerFor(input.provider);
  const referencePaths = input.firstFramePath
    ? [input.firstFramePath]
    : input.characterContext?.references.map((reference) => reference.path);
  const baseRequest = {
    prompt: input.prompt,
    size: input.size,
    seconds: input.seconds,
    referencePaths,
    characterContext: input.characterContext,
  };
  const result =
    input.provider === "openai"
      ? await provider.generateAsset({
          provider: "openai",
          kind: "video",
          ...baseRequest,
        })
      : input.provider === "gemini"
        ? await provider.generateAsset({
            provider: "gemini",
            kind: "video",
            ...baseRequest,
          })
        : input.provider === "runway"
          ? await provider.generateAsset({
              provider: "runway",
              kind: "video",
              ...baseRequest,
            })
          : await provider.generateAsset({
              provider: "ltx",
              kind: "video",
              ...baseRequest,
            });
  await fs.mkdir(GENERATED_DIR, { recursive: true });
  const id = newId("vid");
  const filename = `${id}.${result.extension}`;
  const characterBinding = input.characterContext
    ? oneShotCharacterBinding({
        assetId: id,
        context: input.characterContext,
        providerSettings: result.providerSettings
          ? {
              provider: result.provider,
              model: result.model,
              ...result.providerSettings,
            }
          : undefined,
      })
    : undefined;
  await fs.writeFile(path.join(GENERATED_DIR, filename), result.bytes);
  return {
    id,
    filename,
    url: `/generated/${filename}`,
    kind: result.kind,
    durationSec: input.displaySec,
    description: input.description,
    source: "generated",
    generatedBy: {
      provider: result.provider,
      model: result.model,
      prompt: result.prompt,
      characterBinding,
      ...(typeof result.costUsd === "number" ? { costUsd: result.costUsd } : {}),
    },
    characterBinding,
  };
}

// Generate a reusable reference image for one anchor (character, product,
// location, logo/screen, …) from its text description. Used as a consistency
// reference when seeding per-beat keyframes. Gemini ("nano banana") is used
// because it will render/edit photorealistic minors, which OpenAI image gen
// rejects. Returns the saved path, or null if Gemini is unavailable/fails.
export async function generateAnchorImage(input: {
  subject: string;
  style: string;
  aspectRatio: string;
}): Promise<string | null> {
  if (!process.env.GEMINI_API_KEY) return null;

  const prompt = [
    "Create one clean cinematic reference image of the subject below, to be reused as a consistency anchor across multiple video shots.",
    `Subject: ${input.subject}.`,
    `${input.aspectRatio} aspect-ratio framing. Visual style: ${input.style}.`,
    "Show the subject clearly and recognizably with even, neutral lighting and a simple uncluttered background. Photorealistic live-action. No text, logos, captions, or watermarks.",
  ].join(" ");

  const result = await providerFor("gemini").generateAsset({
    provider: "gemini",
    kind: "image",
    prompt,
  });

  await fs.mkdir(ANCHOR_DIR, { recursive: true });
  const filePath = path.join(ANCHOR_DIR, `${newId("anchor")}.${result.extension}`);
  await fs.writeFile(filePath, result.bytes);
  return filePath;
}

// Generate a per-beat keyframe: a fresh image for this shot that keeps the given
// anchor subject(s) visually identical to their reference images, in the beat's
// pose/scene — used as the image-to-video first frame. Seeding each beat with a
// purpose-built frame (rather than one static portrait) keeps shots varied while
// preserving consistency. Returns null when there are no anchors for the beat
// (caller runs plain text-to-video) or if Gemini is unavailable/fails.
export async function generateBeatKeyframe(input: {
  beat: Beat;
  beatIndex: number;
  totalBeats: number;
  style: string;
  aspectRatio: string;
  anchors: ResolvedAnchor[];
}): Promise<string | null> {
  if (!process.env.GEMINI_API_KEY || input.anchors.length === 0) return null;

  const referenceLines = input.anchors
    .map((anchor, index) => `Reference ${index + 1} — ${anchor.subject}.`)
    .join(" ");
  const prompt = [
    "Create a NEW cinematic photographic still for this shot. Keep the reference subject(s) below visually identical to the provided reference image(s) — same identity/appearance, materials, colors, and design.",
    `${input.aspectRatio} aspect-ratio framing.`,
    "[REFERENCE SUBJECTS]",
    referenceLines,
    "[SHOT]",
    `Beat ${input.beatIndex + 1} of ${input.totalBeats} — ${input.beat.name}: ${input.beat.intent}.`,
    `Visual style: ${input.style}.`,
    "Do not redesign, recast, or replace the reference subjects. Photorealistic live-action, cinematic lighting, strong composition, depth and subject/background separation. No text, logos, captions, or watermarks.",
  ].join(" ");

  const result = await providerFor("gemini").generateAsset({
    provider: "gemini",
    kind: "image",
    prompt,
    referencePaths: input.anchors.map((anchor) => anchor.imagePath),
  });

  await fs.mkdir(KEYFRAME_DIR, { recursive: true });
  const filePath = path.join(KEYFRAME_DIR, `${newId("kf")}.${result.extension}`);
  await fs.writeFile(filePath, result.bytes);
  return filePath;
}
