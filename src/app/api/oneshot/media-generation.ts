import { promises as fs } from "fs";
import path from "path";

import { providerFor } from "@/lib/generative/providers";
import { Beat, CharacterProfile, CharacterReference, Clip } from "@/lib/types";
import { OpenAIVideoSeconds } from "@/lib/generative/types";
import type { CharacterGenerationContext } from "@/lib/generative/types";
import {
  buildOneShotCharacterDraft,
  describeRecurringCharacter,
  oneShotCharacterBinding,
  oneShotCharacterContext,
  oneShotHeroFramePrompt,
} from "@/lib/oneshot/character-reference";
import { newId } from "./config";
import {
  POPCORN_READY_SCREEN_REFERENCE,
  shouldUsePopcornReadyScreenReference,
  type VideoProvider,
} from "./config";
import { soundtrackPrompt } from "./prompts";

const GENERATED_DIR = path.join(process.cwd(), "public", "generated");
const KEYFRAME_DIR = path.join(GENERATED_DIR, "keyframes");

export async function generateBeatClip(input: {
  provider: VideoProvider;
  prompt: string;
  description: string;
  size: string;
  displaySec: number;
  seconds?: OpenAIVideoSeconds;
  characterContext?: CharacterGenerationContext;
  // When set, this image is the image-to-video first frame instead of the
  // static character hero portrait.
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

export async function popcornReadyScreenReferenceForGoal(
  goal: string
): Promise<string | undefined> {
  if (!shouldUsePopcornReadyScreenReference(goal)) return undefined;

  try {
    await fs.access(POPCORN_READY_SCREEN_REFERENCE);
    return POPCORN_READY_SCREEN_REFERENCE;
  } catch {
    return undefined;
  }
}

export function isQuotaError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("429") ||
    message.includes("RESOURCE_EXHAUSTED") ||
    message.toLowerCase().includes("quota") ||
    message.toLowerCase().includes("rate limit")
  );
}

export async function optionalOneShotStep<T>(
  label: string,
  run: () => Promise<T>
): Promise<T | null> {
  try {
    return await run();
  } catch (err) {
    console.warn(`[oneshot] optional step failed: ${label}`, err);
    return null;
  }
}

export async function generateCharacterHeroFrame(input: {
  goal: string;
  style: string;
}): Promise<{
  profile: CharacterProfile;
  reference: CharacterReference;
  clip: Clip;
  path: string;
} | null> {
  if (!process.env.OPENAI_API_KEY) {
    console.warn(
      "[oneshot] OPENAI_API_KEY is not configured; skipping generated character hero frame"
    );
    return null;
  }

  const provider = providerFor("openai");
  const prompt = oneShotHeroFramePrompt(input);
  const result = await provider.generateAsset({
    provider: "openai",
    kind: "image",
    prompt,
    size: "1024x1024",
    quality: "high",
  });

  await fs.mkdir(GENERATED_DIR, { recursive: true });
  const clipId = newId("img");
  const profileId = newId("char");
  const referenceId = newId("ref");
  const filename = `${clipId}_hero.${result.extension}`;
  const filePath = path.join(GENERATED_DIR, filename);
  const now = new Date().toISOString();
  const draft = buildOneShotCharacterDraft({
    goal: input.goal,
    projectId: "default",
    profileId,
    referenceId,
    assetId: clipId,
    now,
  });
  const referenceUrl = `/generated/${filename}`;
  const context = oneShotCharacterContext({
    profile: draft.profile,
    reference: draft.reference,
    referencePath: filePath,
    referenceUrl,
    originalPrompt: input.goal,
    providerPrompt: prompt,
  });
  const characterBinding = oneShotCharacterBinding({
    assetId: clipId,
    context,
    providerSettings: result.providerSettings
      ? {
          provider: result.provider,
          model: result.model,
          ...result.providerSettings,
        }
      : undefined,
  });

  await fs.writeFile(filePath, result.bytes);

  return {
    ...draft,
    clip: {
      id: clipId,
      filename,
      url: referenceUrl,
      kind: "image",
      durationSec: 4,
      description: "Generated one-shot protagonist hero reference.",
      source: "generated",
      generatedBy: {
        provider: result.provider,
        model: result.model,
        prompt: result.prompt,
        characterBinding,
      },
      characterBinding,
    },
    path: filePath,
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

export async function generateSoundtrack(input: {
  goal: string;
  style: string;
  targetLengthSec: number;
  beats: Beat[];
}): Promise<Clip | null> {
  if (!process.env.ELEVENLABS_API_KEY) return null;

  const prompt = soundtrackPrompt(input);
  const provider = providerFor("elevenlabs");
  const result = await provider.generateAsset({
    provider: "elevenlabs",
    kind: "audio",
    audioMode: "music",
    prompt,
    seconds: input.targetLengthSec,
    forceInstrumental: true,
  });

  await fs.mkdir(GENERATED_DIR, { recursive: true });
  const id = newId("aud");
  const filename = `${id}_soundtrack.${result.extension}`;
  await fs.writeFile(path.join(GENERATED_DIR, filename), result.bytes);

  return {
    id,
    filename,
    url: `/generated/${filename}`,
    kind: "audio",
    durationSec: result.durationSec || input.targetLengthSec,
    description: "AI-selected instrumental soundtrack for the one-shot video.",
    source: "generated",
    generatedBy: {
      provider: result.provider,
      model: result.model,
      prompt: result.prompt,
      ...(typeof result.costUsd === "number" ? { costUsd: result.costUsd } : {}),
    },
  };
}
