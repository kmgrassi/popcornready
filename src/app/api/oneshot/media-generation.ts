import { promises as fs } from "fs";
import path from "path";

import { providerFor } from "@/lib/generative/providers";
import { Beat, CharacterProfile, CharacterReference, Clip } from "@/lib/types";
import {
  buildOneShotCharacterDraft,
  oneShotCharacterBinding,
  oneShotCharacterContext,
  oneShotHeroFramePrompt,
} from "@/lib/oneshot/character-reference";
import { newId } from "./config";
import { soundtrackPrompt } from "./prompts";

// generateBeatClip / generateBeatKeyframe are shared with the v1 runs pipeline
// (src/lib/runs/execute.ts), so they live in a provider-agnostic lib module.
// Re-exported here so the one-shot helpers barrel keeps surfacing them.
export {
  generateBeatClip,
  generateBeatKeyframe,
} from "@/lib/generative/beat-clip";

const GENERATED_DIR = path.join(process.cwd(), "public", "generated");

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
