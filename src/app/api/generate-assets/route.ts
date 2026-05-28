import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { addClip, getProject } from "@/lib/store";
import { Clip } from "@/lib/types";
import { providerFor } from "@/lib/generative/providers";
import { measureAudioDurationSec } from "@/lib/generative/audio-duration";
import { preflightGenerationContent } from "@/lib/generative/preflight";
import {
  buildCharacterPrompt,
  parseConsistencyMode,
  resolveCharacterGenerationContext,
} from "@/lib/generative/character-context";
import {
  AudioGenerationMode,
  DialogueInput,
  GenerativeAssetKind,
  GenerativeProviderName,
  ShotDelta,
} from "@/lib/generative/types";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

const GENERATED_DIR = path.join(process.cwd(), "public", "generated");
const PUBLIC_DIR = path.join(process.cwd(), "public");
const AUDIO_MODES = new Set(["speech", "dialogue", "sound_effect", "music"]);

function newId(prefix: string): string {
  return `${prefix}_` + Math.random().toString(36).slice(2, 10);
}

function localPublicPath(url: string): string | null {
  if (!url.startsWith("/uploads/") && !url.startsWith("/generated/")) {
    return null;
  }
  const filePath = path.normalize(path.join(process.cwd(), "public", url));
  const publicRoot = path.join(process.cwd(), "public");
  if (!filePath.startsWith(publicRoot)) return null;
  return filePath;
}

function parseAudioMode(value: unknown): AudioGenerationMode | undefined {
  const mode = String(value || "");
  return AUDIO_MODES.has(mode) ? (mode as AudioGenerationMode) : undefined;
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function parseShotDelta(value: unknown): ShotDelta | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  return {
    action: source.action ? String(source.action) : undefined,
    camera: source.camera ? String(source.camera) : undefined,
    setting: source.setting ? String(source.setting) : undefined,
    emotion: source.emotion ? String(source.emotion) : undefined,
    prompt: source.prompt ? String(source.prompt) : undefined,
  };
}

function statusForError(message: string): number {
  const badRequestMarkers = [
    "Unsupported consistencyMode",
    "does not support consistencyMode",
    "Unknown character profile",
    "Unknown character reference",
    "Unknown generated asset",
    "is archived",
    "is not approved",
    "does not belong",
    "requires at least one",
    "points to a missing asset",
    "must point to an image",
    "must be local",
    "path escapes public root",
  ];
  return badRequestMarkers.some((marker) => message.includes(marker)) ? 400 : 500;
}

function normalizeProviderName(
  value: unknown,
  kind: GenerativeAssetKind
): GenerativeProviderName | null {
  const raw = String(value || (kind === "audio" ? "elevenlabs" : "openai"));
  const name = raw.toLowerCase();
  if (name === "openai") return "openai";
  if (name === "gemini") return "gemini";
  if (name === "elevenlabs") return "elevenlabs";
  if (name === "mock") return "mock";
  if (name === "nanobanano" || name === "nano-banano" || name === "nano_banano") {
    return "nanobanano";
  }
  return null;
}

function validateProviderKind(
  providerName: GenerativeProviderName,
  kind: GenerativeAssetKind
): string | null {
  if (providerName === "openai" && (kind === "image" || kind === "video")) {
    return null;
  }
  if (providerName === "gemini" && kind === "video") return null;
  if (providerName === "elevenlabs" && kind === "audio") return null;
  if (providerName === "mock" && kind === "image") return null;
  if (providerName === "nanobanano") {
    return "NanoBanano provider is registered but not implemented yet.";
  }
  return `${providerName} provider does not support ${kind} generation.`;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const kind = String(body.kind || "image") as GenerativeAssetKind;
    const providerName = normalizeProviderName(body.provider, kind);
    const audioMode = parseAudioMode(body.audioMode);
    const regenerateFromClipId = body.regenerateFromClipId
      ? String(body.regenerateFromClipId)
      : undefined;
    const project = await getProject();
    const regenerateFromClip = regenerateFromClipId
      ? project.clips.find((clip: Clip) => clip.id === regenerateFromClipId)
      : undefined;
    if (regenerateFromClipId && !regenerateFromClip) {
      return NextResponse.json(
        { error: `Unknown generated asset: ${regenerateFromClipId}.` },
        { status: 400 }
      );
    }

    const previousBinding = regenerateFromClip?.generatedBy?.characterBinding;
    const prompt = String(
      body.prompt ||
        body.shotDelta?.prompt ||
        previousBinding?.originalPrompt ||
        regenerateFromClip?.generatedBy?.prompt ||
        ""
    ).trim();
    const dialogueInputs: DialogueInput[] | undefined = Array.isArray(body.dialogueInputs)
      ? body.dialogueInputs.map((line: any) => ({
          text: String(line.text || ""),
          voiceId: String(line.voiceId || line.voice_id || ""),
        }))
      : undefined;
    const hasDialogueText =
      kind === "audio" &&
      audioMode === "dialogue" &&
      Boolean(dialogueInputs?.some((line: DialogueInput) => line.text.trim()));
    const description = String(
      body.description ||
        prompt ||
        dialogueInputs?.map((line: DialogueInput) => line.text).filter(Boolean).join(" ")
    );
    const seconds = body.seconds ? Number(body.seconds) : undefined;
    const durationSec =
      Number(body.durationSec) || (kind === "image" ? 4 : seconds || 8);
    const referenceClipIds = parseStringArray(body.referenceClipIds);
    const characterProfileIds =
      parseStringArray(body.characterProfileIds).length > 0
        ? parseStringArray(body.characterProfileIds)
        : previousBinding?.characterProfileIds || [];
    const characterReferenceIds =
      parseStringArray(body.characterReferenceIds).length > 0
        ? parseStringArray(body.characterReferenceIds)
        : previousBinding?.referenceIds || [];
    const consistencyMode = body.consistencyMode
      ? parseConsistencyMode(body.consistencyMode)
      : previousBinding?.consistencyMode ||
        (characterProfileIds.length > 0 ? "reference_pack" : "prompt_only");
    const shotDelta = parseShotDelta(body.shotDelta);

    if (kind !== "image" && kind !== "video" && kind !== "audio") {
      return NextResponse.json(
        { error: "kind must be image, video, or audio." },
        { status: 400 }
      );
    }
    if (!providerName) {
      return NextResponse.json(
        { error: `Unknown generative provider: ${String(body.provider || "")}` },
        { status: 400 }
      );
    }
    if (kind === "audio" && providerName !== "elevenlabs") {
      return NextResponse.json(
        { error: "Audio generation requires provider=elevenlabs." },
        { status: 400 }
      );
    }
    const providerKindError = validateProviderKind(providerName, kind);
    if (providerKindError) {
      return NextResponse.json({ error: providerKindError }, { status: 400 });
    }
    if (!prompt && !hasDialogueText) {
      return NextResponse.json(
        { error: "Prompt is required unless dialogueInputs are provided." },
        { status: 400 }
      );
    }

    const preflightPrompt =
      prompt ||
      dialogueInputs?.map((line: DialogueInput) => line.text).join("\n") ||
      "";
    const preflight = await preflightGenerationContent({
      provider: providerName,
      kind,
      prompt: preflightPrompt,
      description,
      iterations: body.preflightReviewIterations,
      script: body.script || project.goal || undefined,
      storyboard: body.storyboard,
      prompts: Array.isArray(body.prompts) ? body.prompts.map(String) : undefined,
      dialogueInputs,
      storyContext: body.storyContext || project.storyContext,
      plan: project.plan,
      clips: project.clips,
    });
    const referencePaths = referenceClipIds
      .map((id: string) =>
        project.clips.find((clip: Clip) => clip.id === id)
      )
      .filter((clip: Clip | undefined): clip is Clip => Boolean(clip))
      .map((clip: Clip) => localPublicPath(clip.url))
      .filter((filePath: string | null): filePath is string =>
        Boolean(filePath)
      );

    const provider = providerFor(providerName);
    const characterContext = resolveCharacterGenerationContext({
      project,
      provider: provider.name,
      kind,
      prompt: preflight.finalPrompt,
      publicRoot: PUBLIC_DIR,
      characterProfileIds,
      characterReferenceIds,
      consistencyMode,
      shotDelta,
    });
    const characterReferencePaths =
      characterContext?.references.map((reference) => reference.path) || [];
    const providerPrompt = characterContext
      ? buildCharacterPrompt({
          profiles: characterContext.profiles,
          prompt: preflight.finalPrompt,
          shotDelta,
        })
      : preflight.finalPrompt;

    const result = await provider.generateAsset({
      provider: provider.name,
      kind,
      prompt: providerPrompt,
      referencePaths: [...characterReferencePaths, ...referencePaths],
      characterContext,
      model: body.model ? String(body.model) : undefined,
      size: body.size ? String(body.size) : undefined,
      quality: body.quality,
      seconds,
      audioMode,
      voiceId: body.voiceId ? String(body.voiceId) : undefined,
      outputFormat: body.outputFormat ? String(body.outputFormat) : undefined,
      languageCode: body.languageCode ? String(body.languageCode) : undefined,
      dialogueInputs: preflight.finalDialogueInputs || dialogueInputs,
      loop:
        typeof body.loop === "boolean"
          ? body.loop
          : undefined,
      promptInfluence:
        typeof body.promptInfluence === "number"
          ? body.promptInfluence
          : undefined,
      forceInstrumental:
        typeof body.forceInstrumental === "boolean"
          ? body.forceInstrumental
          : undefined,
    });

    await fs.mkdir(GENERATED_DIR, { recursive: true });
    const id = newId(kind === "image" ? "img" : kind === "audio" ? "aud" : "vid");
    const filename = `${id}.${result.extension}`;
    await fs.writeFile(path.join(GENERATED_DIR, filename), result.bytes);

    const measuredDurationSec =
      result.kind === "audio"
        ? measureAudioDurationSec(result.bytes, result.extension) ?? undefined
        : undefined;
    const effectiveDurationSec =
      measuredDurationSec && measuredDurationSec > 0
        ? measuredDurationSec
        : durationSec;

    const clip: Clip = {
      id,
      filename,
      url: `/generated/${filename}`,
      kind: result.kind,
      durationSec: effectiveDurationSec,
      ...(measuredDurationSec ? { measuredDurationSec } : {}),
      description: preflight.finalDescription,
      source: "generated",
      generatedBy: {
        provider: result.provider,
        model: result.model,
        prompt: preflight.finalPrompt,
        providerPrompt: result.prompt,
        originalPrompt:
          preflight.originalPrompt === preflight.finalPrompt
            ? undefined
            : preflight.originalPrompt,
        preflight:
          preflight.completedIterations > 0
            ? preflight
            : undefined,
        ...(characterContext
          ? {
              characterBinding: {
                assetId: id,
                characterProfileIds: characterContext.profiles.map(
                  (profile) => profile.id
                ),
                referenceIds: characterContext.references.map(
                  ({ reference }) => reference.id
                ),
                consistencyMode: characterContext.consistencyMode,
                originalPrompt: preflight.originalPrompt,
                promptInvariantVersion:
                  characterContext.promptInvariantVersion,
                providerSettings: {
                  provider: result.provider,
                  model: result.model,
                  references: characterContext.references.map(
                    ({ reference }) => reference.id
                  ),
                  mode: characterContext.consistencyMode,
                  durationSec,
                  aspectRatio: body.size ? String(body.size) : undefined,
                  promptInvariantVersion:
                    characterContext.promptInvariantVersion,
                  ...result.providerSettings,
                },
              },
            }
          : {}),
      },
    };

    const updated = await addClip(clip);
    return NextResponse.json({ clip, project: updated });
  } catch (err: any) {
    const message = err?.message || "Asset generation failed";
    return NextResponse.json(
      { error: message },
      { status: statusForError(message) }
    );
  }
}
