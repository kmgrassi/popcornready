import { promises as fs } from "fs";
import path from "path";

import { providerFor } from "@/lib/generative/providers";
import type { Beat, Clip } from "@/lib/types";
import type { CharacterGenerationContext } from "@/lib/generative/types";
import {
  describeRecurringCharacter,
  oneShotCharacterBinding,
} from "@/lib/oneshot/character-reference";

export type VideoProvider = "openai" | "gemini" | "runway" | "ltx";

const GENERATED_DIR = path.join(process.cwd(), "public", "generated");
const KEYFRAME_DIR = path.join(GENERATED_DIR, "keyframes");

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

// Generate a per-beat keyframe: a fresh image of the SAME character (conditioned
// on the hero frame) in this beat's pose/scene, to seed image-to-video. This
// replaces seeding every clip with the one static hero portrait, which made
// every shot open identically. Returns the saved image path, or null if Gemini
// image generation is unavailable/fails (caller falls back to the hero frame).
export async function generateBeatKeyframe(input: {
  goal: string;
  style: string;
  beat: Beat;
  beatIndex: number;
  totalBeats: number;
  aspectRatio: string;
  heroPath: string;
}): Promise<string | null> {
  if (!process.env.GEMINI_API_KEY) return null;

  const character = describeRecurringCharacter(input.goal);
  const prompt = [
    "Using the SAME character from the reference image (same face, hair, build, and wardrobe anchors), create a NEW cinematic photographic still.",
    `${input.aspectRatio} aspect-ratio framing.`,
    "[CHARACTER INVARIANTS]",
    character.identityInvariants,
    character.wardrobeInvariants,
    character.negativePrompt,
    "[SHOT]",
    `Beat ${input.beatIndex + 1} of ${input.totalBeats} — ${input.beat.name}: ${input.beat.intent}.`,
    `Visual style: ${input.style}.`,
    "Photorealistic live-action, cinematic lighting, strong composition, depth and subject/background separation. No text, logos, captions, or watermarks.",
  ].join(" ");

  const provider = providerFor("gemini");
  const result = await provider.generateAsset({
    provider: "gemini",
    kind: "image",
    prompt,
    referencePaths: [input.heroPath],
  });

  await fs.mkdir(KEYFRAME_DIR, { recursive: true });
  const filename = `${newId("kf")}.${result.extension}`;
  const filePath = path.join(KEYFRAME_DIR, filename);
  await fs.writeFile(filePath, result.bytes);
  return filePath;
}
