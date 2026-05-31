import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { providerFor } from "@/lib/generative/providers";
import {
  buildOneShotCharacterDraft,
  oneShotCharacterBinding,
  oneShotCharacterContext,
  oneShotHeroFramePrompt,
} from "@/lib/oneshot/character-reference";
import type { Clip } from "@/lib/types";
import type { CharacterGenerationContext } from "@/lib/generative/types";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

const GENERATED_DIR = path.join(process.cwd(), "public", "generated", "harness");

function newId(prefix: string): string {
  return `${prefix}_` + Math.random().toString(36).slice(2, 10);
}

function requireLocalHarness() {
  if (
    process.env.NODE_ENV === "production" &&
    process.env.ALLOW_LIVE_GENERATION_HARNESS !== "true"
  ) {
    throw new Error(
      "Live generation harness is disabled in production unless ALLOW_LIVE_GENERATION_HARNESS=true."
    );
  }
}

function normalizeGeminiSeconds(value: number): number {
  const candidate = Math.round(Number(value));
  if (!Number.isFinite(candidate)) return 4;
  if (candidate <= 4) return 4;
  if (candidate <= 6) return 6;
  return 8;
}

function videoPrompts(characterBrief: string): string[] {
  return [
    [
      "Use the supplied hero-frame image as the visual identity reference.",
      "Create a short cinematic video of the same child protagonist sitting at a desk in a cozy bedroom at night, smiling with creative excitement.",
      `Character brief: ${characterBrief}`,
      "Do not redesign, recast, age-shift, gender-swap, or replace the protagonist.",
      "No text, captions, logos, or extra main characters.",
    ].join(" "),
    [
      "Use the supplied hero-frame image as the visual identity reference.",
      "Create a short cinematic video of the same child protagonist holding a notebook and sketching a movie idea, lit by a laptop glow.",
      `Character brief: ${characterBrief}`,
      "The face, hair, build, skin tone, and wardrobe anchor should match the reference image.",
      "No text, captions, logos, or extra main characters.",
    ].join(" "),
    [
      "Use the supplied hero-frame image as the visual identity reference.",
      "Create a short cinematic video of the same child protagonist proudly looking at a small homemade film set on the bedroom floor.",
      `Character brief: ${characterBrief}`,
      "Preserve the same recognizable child from the hero image across the whole shot.",
      "No text, captions, logos, or extra main characters.",
    ].join(" "),
  ];
}

async function writeGeneratedClip(input: {
  id: string;
  filename: string;
  bytes: Buffer;
  kind: "image" | "video";
  durationSec: number;
  description: string;
  provider: string;
  model?: string;
  prompt: string;
  characterContext?: CharacterGenerationContext;
  providerSettings?: any;
}): Promise<Clip> {
  await fs.mkdir(GENERATED_DIR, { recursive: true });
  await fs.writeFile(path.join(GENERATED_DIR, input.filename), input.bytes);
  const characterBinding = input.characterContext
    ? oneShotCharacterBinding({
        assetId: input.id,
        context: input.characterContext,
        providerSettings: input.providerSettings
          ? {
              provider: input.provider,
              model: input.model,
              ...input.providerSettings,
            }
          : undefined,
      })
    : undefined;

  return {
    id: input.id,
    filename: input.filename,
    url: `/generated/harness/${input.filename}`,
    kind: input.kind,
    durationSec: input.durationSec,
    description: input.description,
    source: "generated",
    generatedBy: {
      provider: input.provider,
      model: input.model,
      prompt: input.prompt,
      characterBinding,
    },
    characterBinding,
  };
}

export async function POST(req: NextRequest) {
  try {
    requireLocalHarness();

    const body = await req.json().catch(() => ({}));
    const goal = String(
      body.goal ||
        "A 10-year-old movie-loving boy in a bedroom late at night discovers Popcorn Ready and dreams of becoming a filmmaker."
    );
    const style = String(body.style || "cinematic live-action");
    const requestedSeconds = Number(body.seconds) || 2;
    const effectiveSeconds = normalizeGeminiSeconds(requestedSeconds);
    const videoProvider = String(body.videoProvider || "gemini");
    const imageProvider = String(body.imageProvider || "openai");
    const imageModel = body.imageModel ? String(body.imageModel) : undefined;
    const videoModel = body.videoModel ? String(body.videoModel) : undefined;

    if (imageProvider !== "openai") {
      return NextResponse.json(
        { error: "This harness currently supports imageProvider=openai only." },
        { status: 400 }
      );
    }
    if (videoProvider !== "gemini" && videoProvider !== "openai") {
      return NextResponse.json(
        { error: "videoProvider must be gemini or openai." },
        { status: 400 }
      );
    }

    const imagePrompt = oneShotHeroFramePrompt({ goal, style });
    const imageResult = await providerFor("openai").generateAsset({
      provider: "openai",
      kind: "image",
      prompt: imagePrompt,
      model: imageModel,
      size: "1024x1024",
      quality: "low",
    });

    const now = new Date().toISOString();
    const imageId = newId("img");
    const profileId = newId("char");
    const referenceId = newId("ref");
    const imageFilename = `${imageId}_hero.${imageResult.extension}`;
    const imagePath = path.join(GENERATED_DIR, imageFilename);
    const draft = buildOneShotCharacterDraft({
      goal,
      projectId: "debug-character-reference-video",
      profileId,
      referenceId,
      assetId: imageId,
      now,
    });
    const imageContext = oneShotCharacterContext({
      profile: draft.profile,
      reference: draft.reference,
      referencePath: imagePath,
      referenceUrl: `/generated/harness/${imageFilename}`,
      originalPrompt: goal,
      providerPrompt: imagePrompt,
    });
    const heroClip = await writeGeneratedClip({
      id: imageId,
      filename: imageFilename,
      bytes: imageResult.bytes,
      kind: "image",
      durationSec: 4,
      description: "Manual harness hero-frame reference.",
      provider: imageResult.provider,
      model: imageResult.model,
      prompt: imageResult.prompt,
      characterContext: imageContext,
      providerSettings: imageResult.providerSettings,
    });

    const prompts = videoPrompts(draft.profile.identityInvariants);
    const videoClips: Clip[] = [];
    for (let index = 0; index < prompts.length; index += 1) {
      const prompt = prompts[index];
      const characterContext = oneShotCharacterContext({
        profile: draft.profile,
        reference: draft.reference,
        referencePath: imagePath,
        referenceUrl: heroClip.url,
        originalPrompt: goal,
        providerPrompt: prompt,
      });
      const result =
        videoProvider === "gemini"
          ? await providerFor("gemini").generateAsset({
              provider: "gemini",
              kind: "video",
              prompt,
              model: videoModel,
              size: "1280x720",
              seconds: requestedSeconds,
              referencePaths: [imagePath],
              characterContext,
            })
          : await providerFor("openai").generateAsset({
              provider: "openai",
              kind: "video",
              prompt,
              model: videoModel,
              size: "1280x720",
              seconds: requestedSeconds,
              referencePaths: [imagePath],
              characterContext,
            });
      const id = newId("vid");
      videoClips.push(
        await writeGeneratedClip({
          id,
          filename: `${id}_reference_${index + 1}.${result.extension}`,
          bytes: result.bytes,
          kind: "video",
          durationSec: effectiveSeconds,
          description: `Manual character-reference video ${index + 1}.`,
          provider: result.provider,
          model: result.model,
          prompt: result.prompt,
          characterContext,
          providerSettings: result.providerSettings,
        })
      );
    }

    return NextResponse.json({
      goal,
      requestedSeconds,
      effectiveSeconds,
      note:
        requestedSeconds !== effectiveSeconds
          ? "Provider duration was normalized to the closest supported low-cost duration."
          : undefined,
      heroImage: heroClip,
      videos: videoClips,
      characterProfile: draft.profile,
      characterReference: draft.reference,
    });
  } catch (err: any) {
    console.error("[debug/character-reference-video] failed", err);
    return NextResponse.json(
      { error: err?.message || "Character reference video harness failed." },
      { status: 500 }
    );
  }
}
