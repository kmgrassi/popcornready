// PR2: Generated Asset Endpoint For Agents.
//
// Turns an agent generation request into a normal project asset (in the PR1
// asset store) with full provenance, modeled as an `asset_generation` job.
// Reuses the existing preflight + provider pipeline; adds typed errors and
// actual audio-duration capture. Idempotency is handled by the shared
// handleMutation wrapper, so this module stays framework-free and testable.

import { promises as fs } from "fs";
import path from "path";
import { parseConsistencyMode } from "@/lib/generative/character-context";
import { measureAudioDurationSec } from "@/lib/generative/audio-duration";
import { preflightGenerationContent } from "@/lib/generative/preflight";
import { providerFor } from "@/lib/generative/providers";
import {
  AudioGenerationMode,
  DialogueInput,
  GenerativeAssetKind,
  GenerativeProviderName,
} from "@/lib/generative/types";
import type { GeneratedAssetCharacterBinding } from "@/lib/types";
import { AuthContext } from "./auth";
import { ApiError, FieldError, validationError } from "./errors";
import { newId } from "./ids";
import { createJob, getJob, updateJob, V1Job } from "./jobs";
import {
  GeneratedAssetProvenance,
  GeneratedAssetProviderSettings,
} from "./provenance";
import { AssetKind, SCHEMA_VERSIONS } from "./schemas";
import {
  addAsset,
  getAsset,
  getProject,
  localDir,
  mediaGeneratedDir,
  V1Asset,
} from "./store";

export interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}

const CHARACTER_PROMPT_INVARIANT_VERSION = "char.invariant.v1";
const AUDIO_MODES = new Set(["speech", "dialogue", "sound_effect", "music"]);

// provider -> supported kinds for the agent endpoint.
const PROVIDER_KIND_SUPPORT: Record<
  GenerativeProviderName,
  GenerativeAssetKind[]
> = {
  openai: ["image", "video"],
  gemini: ["video"],
  elevenlabs: ["audio"],
  mock: ["image", "video", "audio"],
  nanobanano: [],
};

interface ParsedRequest {
  kind: GenerativeAssetKind;
  provider: GenerativeProviderName;
  prompt: string;
  description: string;
  durationSec: number;
  providerSeconds?: number;
  referenceAssetIds: string[];
  characterProfileIds: string[];
  characterReferenceIds: string[];
  consistencyMode: ReturnType<typeof parseConsistencyMode>;
  preflightIterations: number;
  audioMode?: AudioGenerationMode;
  dialogueInputs?: DialogueInput[];
  model?: string;
  size?: string;
  quality?: "low" | "medium" | "high" | "auto";
  voiceId?: string;
  outputFormat?: string;
  languageCode?: string;
  loop?: boolean;
  promptInfluence?: number;
  forceInstrumental?: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function compact<T extends object>(obj: T): T | undefined {
  const entries = Object.entries(obj).filter(([, v]) => v !== undefined);
  return entries.length ? (Object.fromEntries(entries) as T) : undefined;
}

function normalizeProvider(
  value: unknown,
  kind: GenerativeAssetKind
): GenerativeProviderName | null {
  const fallback = kind === "audio" ? "elevenlabs" : "openai";
  const name = String(value || fallback).toLowerCase();
  if (name === "openai") return "openai";
  if (name === "gemini") return "gemini";
  if (name === "elevenlabs") return "elevenlabs";
  if (name === "mock") return "mock";
  if (name === "nanobanano" || name === "nano-banano" || name === "nano_banano") {
    return "nanobanano";
  }
  return null;
}

function parseAudioMode(value: unknown): AudioGenerationMode | undefined {
  const mode = String(value || "");
  return AUDIO_MODES.has(mode) ? (mode as AudioGenerationMode) : undefined;
}

function parseQuality(value: unknown): ParsedRequest["quality"] {
  const q = String(value || "");
  return q === "low" || q === "medium" || q === "high" || q === "auto"
    ? q
    : undefined;
}

function parseGeneratedAssetRequest(body: unknown): ParsedRequest {
  if (!isPlainObject(body)) {
    throw validationError("The request body is invalid.", [
      { path: "", message: "Must be an object." },
    ]);
  }
  const fields: FieldError[] = [];

  const kind = String(body.kind ?? "image") as GenerativeAssetKind;
  if (kind !== "image" && kind !== "video" && kind !== "audio") {
    throw validationError("The request body is invalid.", [
      { path: "kind", message: "Must be one of: image, video, audio." },
    ]);
  }

  const provider = normalizeProvider(body.provider, kind);
  if (!provider) {
    throw validationError("The request body is invalid.", [
      { path: "provider", message: `Unknown provider: ${String(body.provider)}.` },
    ]);
  }

  const supportedKinds = PROVIDER_KIND_SUPPORT[provider];
  if (!supportedKinds.includes(kind)) {
    const reason = supportedKinds.length
      ? `Provider "${provider}" supports ${supportedKinds.join(
          ", "
        )} generation, not ${kind}.`
      : `Provider "${provider}" is registered but not implemented yet.`;
    throw validationError("The request body is invalid.", [
      { path: "provider", message: reason },
    ]);
  }

  const audioMode = parseAudioMode(body.audioMode);
  const dialogueInputs: DialogueInput[] | undefined = Array.isArray(
    body.dialogueInputs
  )
    ? (body.dialogueInputs as unknown[]).map((line) => {
        const entry = isPlainObject(line) ? line : {};
        return {
          text: String(entry.text || ""),
          voiceId: String(entry.voiceId || entry.voice_id || ""),
        };
      })
    : undefined;
  const hasDialogueText =
    kind === "audio" &&
    audioMode === "dialogue" &&
    Boolean(dialogueInputs?.some((line) => line.text.trim()));

  const prompt = String(body.prompt || "").trim();
  if (!prompt && !hasDialogueText) {
    throw validationError("The request body is invalid.", [
      { path: "prompt", message: "prompt is required unless dialogueInputs are provided." },
    ]);
  }

  const dialogueText = dialogueInputs
    ?.map((line) => line.text)
    .filter(Boolean)
    .join(" ");
  const description = String(body.description || prompt || dialogueText || "");

  const seconds =
    body.seconds !== undefined ? Number(body.seconds) : undefined;
  const durationSec =
    Number(body.durationSec) || (kind === "image" ? 4 : seconds || 8);

  const characterProfileIds = parseStringArray(body.characterProfileIds);
  let consistencyMode: ReturnType<typeof parseConsistencyMode>;
  try {
    consistencyMode =
      body.consistencyMode !== undefined
        ? parseConsistencyMode(body.consistencyMode)
        : parseConsistencyMode(
            characterProfileIds.length > 0 ? "reference_pack" : "prompt_only"
          );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Invalid consistencyMode.";
    fields.push({ path: "consistencyMode", message });
    throw validationError("The request body is invalid.", fields);
  }

  const preflightIterations =
    body.preflightReviewIterations === undefined
      ? 0
      : Number(body.preflightReviewIterations);

  return {
    kind,
    provider,
    prompt,
    description,
    durationSec,
    providerSeconds: kind === "image" ? undefined : durationSec,
    referenceAssetIds: parseStringArray(body.referenceAssetIds),
    characterProfileIds,
    characterReferenceIds: parseStringArray(body.characterReferenceIds),
    consistencyMode,
    preflightIterations,
    audioMode,
    dialogueInputs,
    model: body.model ? String(body.model) : undefined,
    size: body.size ? String(body.size) : undefined,
    quality: parseQuality(body.quality),
    voiceId: body.voiceId ? String(body.voiceId) : undefined,
    outputFormat: body.outputFormat ? String(body.outputFormat) : undefined,
    languageCode: body.languageCode ? String(body.languageCode) : undefined,
    loop: typeof body.loop === "boolean" ? body.loop : undefined,
    promptInfluence:
      typeof body.promptInfluence === "number" ? body.promptInfluence : undefined,
    forceInstrumental:
      typeof body.forceInstrumental === "boolean"
        ? body.forceInstrumental
        : undefined,
  };
}

async function runGeneration(
  auth: AuthContext,
  projectId: string,
  parsed: ParsedRequest
): Promise<V1Asset> {
  // Resolve reference assets to local file paths the provider can read.
  const referencePaths: string[] = [];
  for (const id of parsed.referenceAssetIds) {
    const asset = await getAsset(auth.workspaceId, projectId, id); // throws not_found
    if (asset.status !== "ready" || !asset.storageKey) {
      throw new ApiError(
        "asset_not_ready",
        `Reference asset is not ready: ${id}.`,
        { assetIds: [id] }
      );
    }
    referencePaths.push(path.join(localDir(), asset.storageKey));
  }

  const preflight = await preflightGenerationContent({
    provider: parsed.provider,
    kind: parsed.kind,
    prompt: parsed.prompt,
    description: parsed.description,
    iterations: parsed.preflightIterations,
    dialogueInputs: parsed.dialogueInputs,
  });

  const provider = providerFor(parsed.provider);
  const result = await provider.generateAsset({
    provider: parsed.provider,
    kind: parsed.kind,
    prompt: preflight.finalPrompt || parsed.prompt,
    referencePaths,
    model: parsed.model,
    size: parsed.size,
    quality: parsed.quality,
    seconds: parsed.providerSeconds,
    audioMode: parsed.audioMode,
    voiceId: parsed.voiceId,
    outputFormat: parsed.outputFormat,
    languageCode: parsed.languageCode,
    dialogueInputs: preflight.finalDialogueInputs || parsed.dialogueInputs,
    loop: parsed.loop,
    promptInfluence: parsed.promptInfluence,
    forceInstrumental: parsed.forceInstrumental,
  });

  const assetId = newId("asset");
  const filename = `${assetId}.${result.extension}`;
  const dir = mediaGeneratedDir(auth.workspaceId, projectId);
  await fs.mkdir(dir, { recursive: true });
  const destPath = path.join(dir, filename);
  await fs.writeFile(destPath, result.bytes);
  const storageKey = path.relative(localDir(), destPath);

  const actualDurationSec =
    result.kind === "audio"
      ? measureAudioDurationSec(result.bytes, result.extension) ?? undefined
      : undefined;
  const durationSec =
    result.kind === "audio"
      ? actualDurationSec ?? parsed.durationSec
      : parsed.durationSec;

  const characterBinding: GeneratedAssetCharacterBinding | undefined =
    parsed.characterProfileIds.length > 0
      ? {
          assetId,
          characterProfileIds: parsed.characterProfileIds,
          referenceIds: parsed.characterReferenceIds,
          consistencyMode: parsed.consistencyMode,
          originalPrompt: parsed.prompt,
          promptInvariantVersion: CHARACTER_PROMPT_INVARIANT_VERSION,
        }
      : undefined;

  const providerSettings = compact<GeneratedAssetProviderSettings>({
    model: result.model,
    size: parsed.size,
    quality: parsed.quality,
    seconds: parsed.providerSeconds,
    audioMode: parsed.audioMode,
    voiceId: parsed.voiceId,
    outputFormat: parsed.outputFormat,
    languageCode: parsed.languageCode,
    loop: parsed.loop,
    promptInfluence: parsed.promptInfluence,
    forceInstrumental: parsed.forceInstrumental,
    consistency: result.providerSettings as Record<string, unknown> | undefined,
  });

  const provenance: GeneratedAssetProvenance = {
    provider: result.provider,
    model: result.model,
    prompt: preflight.finalPrompt,
    providerPrompt: result.prompt,
    preflight: preflight.completedIterations > 0 ? preflight : undefined,
    referenceAssetIds: parsed.referenceAssetIds.length
      ? parsed.referenceAssetIds
      : undefined,
    characterBinding,
    providerSettings,
    requestedDurationSec: parsed.durationSec,
    actualDurationSec,
  };

  const now = new Date().toISOString();
  const asset: V1Asset = {
    id: assetId,
    schemaVersion: SCHEMA_VERSIONS.asset,
    workspaceId: auth.workspaceId,
    projectId,
    kind: result.kind as AssetKind,
    filename,
    status: "ready",
    source: { type: "generated", generatedAssetId: assetId },
    storageKey,
    durationSec,
    context: parsed.description ? { summary: parsed.description } : undefined,
    provenance,
    createdAt: now,
    updatedAt: now,
  };

  return addAsset(asset);
}

export interface CreateGeneratedAssetArgs {
  auth: AuthContext;
  projectId: string;
  body: unknown;
}

export async function createGeneratedAsset(
  args: CreateGeneratedAssetArgs
): Promise<ApiResult> {
  const { auth, projectId, body } = args;

  await getProject(auth.workspaceId, projectId); // throws not_found
  const parsed = parseGeneratedAssetRequest(body);

  const job = await createJob({
    workspaceId: auth.workspaceId,
    projectId,
    type: "asset_generation",
    status: "running",
    progress: { currentStep: "generating_assets", percent: 10 },
    result: null,
    error: null,
  });

  try {
    const asset = await runGeneration(auth, projectId, parsed);
    const finished = await updateJob(job.id, {
      status: "succeeded",
      progress: { currentStep: "saving_artifact", percent: 100 },
      result: { assetIds: [asset.id] },
      error: null,
    });
    return { status: 202, body: { job: finished } };
  } catch (err) {
    const apiErr =
      err instanceof ApiError
        ? err
        : new ApiError(
            "job_failed",
            err instanceof Error ? err.message : "Asset generation failed."
          );
    await updateJob(job.id, {
      status: "failed",
      error: { code: apiErr.code, message: apiErr.message },
    });
    throw apiErr;
  }
}

export interface GetGeneratedAssetJobArgs {
  auth: AuthContext;
  projectId: string;
  jobId: string;
}

export async function getGeneratedAssetJob(
  args: GetGeneratedAssetJobArgs
): Promise<ApiResult> {
  const { auth, projectId, jobId } = args;
  await getProject(auth.workspaceId, projectId); // throws not_found

  const job: V1Job | null = await getJob(jobId);
  if (
    !job ||
    job.workspaceId !== auth.workspaceId ||
    job.projectId !== projectId ||
    job.type !== "asset_generation"
  ) {
    throw new ApiError("not_found", `Generated-asset job not found: ${jobId}.`);
  }
  return { status: 200, body: { job } };
}
