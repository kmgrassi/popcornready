import { promises as fs } from "fs";
import path from "path";

import { providerFor } from "@/lib/generative/providers";
import { Beat, CharacterProfile, CharacterReference, Clip } from "@/lib/types";
import type { Asset } from "@/lib/assets/types";
import { clipToAsset } from "@/lib/assets/types";
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
import type { VideoProvider } from "./config";
import { soundtrackPrompt, soundtrackRequestFingerprint } from "./prompts";

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

// Fold the single-hero CharacterProfile identity model onto a self-describing
// `character_anchor` Asset (asset-pool PR E; docs/scopes/north-star-asset-pool.md
// "character fold", NORTH_STAR.md §8 "Retire the single-hero character path").
// The recurring character is now an anchor asset with identity invariants and
// `depicts.characterId`; the `character_anchor` selection holds the active
// likeness. The legacy CharacterProfile/CharacterReference are still produced in
// parallel because the keyframe/clip reference path reads them — a later PR
// removes them once that path consumes the anchor.
export function characterAnchorAsset(input: {
  profile: CharacterProfile;
  clip: Clip;
}): Asset {
  const { profile, clip } = input;
  return {
    id: clip.id,
    schemaVersion: "asset.v1",
    projectId: profile.projectId,
    kind: "image",
    role: "character_anchor",
    depicts: { characterId: profile.id },
    ...(clip.description !== undefined ? { description: clip.description } : {}),
    media: {
      url: clip.url,
      filename: clip.filename,
      durationSec: clip.durationSec,
      ...(clip.measuredDurationSec !== undefined
        ? { measuredDurationSec: clip.measuredDurationSec }
        : {}),
    },
    ...(clip.generatedBy ? { provenance: { ...clip.generatedBy } } : {}),
    source: clip.source ?? "generated",
    characterInvariants: {
      ...(profile.identityInvariants
        ? { identity: profile.identityInvariants }
        : {}),
      ...(profile.wardrobeInvariants
        ? { wardrobe: profile.wardrobeInvariants }
        : {}),
      ...(profile.negativePrompt ? { negative: profile.negativePrompt } : {}),
    },
  };
}

// Represent a generated beat clip as a first-class `beat_clip` pooled Asset
// (Clip/Asset convergence, docs/scopes/north-star-clip-asset-convergence.md).
// Shares the clip's id (so `clips[]` stays the render shape and `poolAssets`
// dedups the twin). Carries the structural input edges `Clip.generatedBy` can't
// hold — its own `beatId` (so a beat edit flags the clip directly, even with no
// keyframe) and `anchorIds` — on top of the `firstFrameAssetId` the clip already
// records. Pure; the caller appends it to the pool and sets the active selection.
export function beatClipAsset(
  clip: Clip,
  beat: Beat,
  opts: { projectId: string; anchorAssetId?: string }
): Asset {
  const asset = clipToAsset(clip, {
    projectId: opts.projectId,
    role: "beat_clip",
    ...(beat.id ? { depicts: { beatId: beat.id } } : {}),
  });
  if (asset.provenance) {
    asset.provenance.inputs = {
      ...asset.provenance.inputs, // firstFrameAssetId, when a keyframe seeded it
      ...(beat.id ? { beatId: beat.id } : {}),
      ...(opts.anchorAssetId ? { anchorIds: [opts.anchorAssetId] } : {}),
    };
  }
  return asset;
}

export async function generateCharacterHeroFrame(input: {
  goal: string;
  style: string;
  // Project the generated character belongs to. Threaded so assets are
  // project-scoped instead of hard-coded (asset-pool PR B).
  projectId?: string;
}): Promise<{
  profile: CharacterProfile;
  reference: CharacterReference;
  clip: Clip;
  path: string;
  // The recurring character represented as a pooled `character_anchor` Asset
  // (asset-pool PR E). The route adds this to the pool and sets the
  // `character_anchor` selection; the legacy profile/reference/clip below remain
  // for the keyframe/clip reference path until a later PR migrates it.
  anchor: Asset;
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
    projectId: input.projectId ?? "default",
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

  const clip: Clip = {
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
  };

  return {
    ...draft,
    clip,
    path: filePath,
    anchor: characterAnchorAsset({ profile: draft.profile, clip }),
  };
}

// Generate a per-beat keyframe: a fresh image of the SAME character (conditioned
// on the hero frame) in this beat's pose/scene, to seed image-to-video. This
// replaces seeding every clip with the one static hero portrait, which made
// every shot open identically.
//
// The keyframe is now a first-class, pooled `Asset` (asset-pool PR D, North Star
// Principle 9 "nothing is throwaway"): the PNG still lives under public/generated
// because the provider needs a real file/url to do image-to-video, but the
// result is a recorded `beat_keyframe` asset (with `depicts.beatId` and
// provenance) rather than a discarded path. Returns the asset plus its local
// file `path` (the provider's image-to-video first frame), or null if Gemini
// image generation is unavailable/fails (caller falls back to the hero frame).
export async function generateBeatKeyframe(input: {
  goal: string;
  style: string;
  beat: Beat;
  beatIndex: number;
  totalBeats: number;
  aspectRatio: string;
  heroPath: string;
  // Project the keyframe asset belongs to (asset-pool PR B). The character
  // anchor it was conditioned on, recorded as an input edge.
  projectId: string;
  anchorAssetId?: string;
}): Promise<{ asset: Asset; path: string } | null> {
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
  const id = newId("kf");
  const filename = `${id}.${result.extension}`;
  const filePath = path.join(KEYFRAME_DIR, filename);
  await fs.writeFile(filePath, result.bytes);

  const asset: Asset = {
    id,
    schemaVersion: "asset.v1",
    projectId: input.projectId,
    kind: "image",
    role: "beat_keyframe",
    depicts: {
      ...(input.beat.id ? { beatId: input.beat.id } : {}),
    },
    description: `Beat ${input.beatIndex + 1} keyframe — ${input.beat.name}: ${input.beat.intent}`,
    media: {
      url: `/generated/keyframes/${filename}`,
      filename,
      durationSec: 0,
    },
    provenance: {
      provider: result.provider,
      ...(result.model !== undefined ? { model: result.model } : {}),
      prompt: result.prompt,
      providerPrompt: prompt,
      originalPrompt: input.goal,
      ...(typeof result.costUsd === "number" ? { costUsd: result.costUsd } : {}),
      inputs: {
        ...(input.beat.id ? { beatId: input.beat.id } : {}),
        ...(input.anchorAssetId ? { anchorIds: [input.anchorAssetId] } : {}),
      },
    },
    source: "generated",
  };

  return { asset, path: filePath };
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
      // Reuse key compared on resume (provenance-graph lane task #7).
      requestFingerprint: soundtrackRequestFingerprint(input),
    },
  };
}
