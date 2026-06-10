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
import { withDerivedAssetKnowledge } from "./assets";
import { preflightGenerationContent } from "@/lib/generative/preflight";
import { providerFor } from "@/lib/generative/providers";
import { estimateCostUsd } from "@/lib/generative/pricing";
import {
  AudioGenerationMode,
  DialogueInput,
  GenerativeAssetKind,
  GenerativeProviderName,
} from "@popcorn/shared/generative/types";
import type { GeneratedAssetCharacterBinding } from "@popcorn/shared/types";
import { buildSemanticAnalysis } from "@/lib/edit-graph/semantic-analysis";
import {
  RunStageHandle,
  RunStageItemHandle,
  stageItemKindForAssetKind,
  toErrorSummary,
} from "@/lib/v1/generation-progress";
import { randomUUID } from "crypto";
import { AuthContext } from "./auth";
import { ApiError, ApiErrorCode, FieldError, validationError } from "./errors";
import { createJob, getJob, updateJob, V1Job } from "./jobs";
import {
  GeneratedAssetProvenance,
  GeneratedAssetProviderSettings,
} from "./provenance";
import { AssetKind, SCHEMA_VERSIONS } from "./schemas";
import {
  addAsset,
  assertRunBudgetAllows,
  createAction,
  getAssetFingerprintPins,
  getAsset,
  getProject,
  localDir,
  mediaGeneratedDir,
  updateAction,
  updateAsset,
  V1Action,
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
  runway: ["video"],
  ltx: ["video"],
  nvidia_api_catalog: ["video"],
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
  beatId?: string;
  anchorIds: string[];
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
  seed?: number;
  frameCount?: number;
  fps?: number;
  steps?: number;
  guidanceScale?: number;
  negativePrompt?: string;
  resolution?: string;
  runId?: string;
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
  const fallback =
    kind === "audio" ? "elevenlabs" : kind === "video" ? "gemini" : "openai";
  const name = String(value || fallback).toLowerCase();
  if (name === "openai") return "openai";
  if (name === "gemini") return "gemini";
  if (name === "runway" || name === "runwayml") return "runway";
  if (name === "ltx" || name === "ltxvideo" || name === "ltx-video") return "ltx";
  if (
    name === "nvidia" ||
    name === "nvidia_api_catalog" ||
    name === "nvidia-api-catalog" ||
    name === "cosmos" ||
    name === "cosmos3" ||
    name === "cosmos3-nano"
  ) {
    return "nvidia_api_catalog";
  }
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

function parseNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
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
    beatId:
      typeof body.beatId === "string" && body.beatId.trim()
        ? body.beatId.trim()
        : undefined,
    anchorIds: parseStringArray(body.anchorIds),
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
    seed: parseNumber(body.seed),
    frameCount: parseNumber(body.frameCount),
    fps: parseNumber(body.fps),
    steps: parseNumber(body.steps),
    guidanceScale: parseNumber(body.guidanceScale),
    negativePrompt: body.negativePrompt
      ? String(body.negativePrompt)
      : undefined,
    resolution: body.resolution ? String(body.resolution) : undefined,
    runId: body.runId ? String(body.runId) : undefined,
  };
}

function actionToolForKind(kind: GenerativeAssetKind): string {
  if (kind === "audio") return "generate_audio";
  if (kind === "video") return "generate_clip";
  return "generate_keyframe";
}

function buildGenerationActionProposal(args: {
  parsed: ParsedRequest;
  jobId: string;
  estimatedCostUsd: number;
  pinnedFingerprints: Record<string, string>;
}): Record<string, unknown> {
  return {
    summary: `Generate ${args.parsed.kind} asset with ${args.parsed.provider}.`,
    plannedWork: [
      {
        tool: actionToolForKind(args.parsed.kind),
        provider: args.parsed.provider,
        kind: args.parsed.kind,
        durationSec: args.parsed.durationSec,
        jobId: args.jobId,
      },
    ],
    pinnedFingerprints: args.pinnedFingerprints,
    estimate: {
      costUsd: args.estimatedCostUsd,
      unit:
        args.parsed.kind === "image"
          ? "generation"
          : `${args.parsed.durationSec}s`,
    },
  };
}

async function runGeneration(
  auth: AuthContext,
  projectId: string,
  parsed: ParsedRequest,
  item: RunStageItemHandle | null,
  action: V1Action
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

  if (item) {
    await item.update({
      progressPercent: 25,
      message:
        parsed.preflightIterations > 0
          ? "Refining the generation prompt."
          : "Preparing the generation prompt.",
    });
  }
  const preflight = await preflightGenerationContent({
    provider: parsed.provider,
    kind: parsed.kind,
    prompt: parsed.prompt,
    description: parsed.description,
    iterations: parsed.preflightIterations,
    dialogueInputs: parsed.dialogueInputs,
  });

  if (item) {
    await item.update({
      progressPercent: 50,
      message: `Calling ${parsed.provider} to generate the ${parsed.kind}.`,
    });
  }
  const provider = providerFor(parsed.provider);
  const baseRequest = {
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
    seed: parsed.seed,
    frameCount: parsed.frameCount,
    fps: parsed.fps,
    steps: parsed.steps,
    guidanceScale: parsed.guidanceScale,
    negativePrompt: parsed.negativePrompt,
    resolution: parsed.resolution,
  };

  let result;
  if (parsed.provider === "openai" && parsed.kind === "image") {
    result = await provider.generateAsset({
      provider: "openai",
      kind: "image",
      ...baseRequest,
    });
  } else if (parsed.provider === "openai" && parsed.kind === "video") {
    result = await provider.generateAsset({
      provider: "openai",
      kind: "video",
      ...baseRequest,
    });
  } else if (parsed.provider === "gemini" && parsed.kind === "video") {
    result = await provider.generateAsset({
      provider: "gemini",
      kind: "video",
      ...baseRequest,
    });
  } else if (parsed.provider === "runway" && parsed.kind === "video") {
    result = await provider.generateAsset({
      provider: "runway",
      kind: "video",
      ...baseRequest,
    });
  } else if (parsed.provider === "ltx" && parsed.kind === "video") {
    result = await provider.generateAsset({
      provider: "ltx",
      kind: "video",
      ...baseRequest,
    });
  } else if (parsed.provider === "nvidia_api_catalog" && parsed.kind === "video") {
    result = await provider.generateAsset({
      provider: "nvidia_api_catalog",
      kind: "video",
      ...baseRequest,
    });
  } else if (parsed.provider === "elevenlabs" && parsed.kind === "audio") {
    result = await provider.generateAsset({
      provider: "elevenlabs",
      kind: "audio",
      ...baseRequest,
    });
  } else if (parsed.provider === "mock" && parsed.kind === "image") {
    result = await provider.generateAsset({
      provider: "mock",
      kind: "image",
      ...baseRequest,
    });
  } else if (parsed.provider === "mock" && parsed.kind === "video") {
    result = await provider.generateAsset({
      provider: "mock",
      kind: "video",
      ...baseRequest,
    });
  } else if (parsed.provider === "mock" && parsed.kind === "audio") {
    result = await provider.generateAsset({
      provider: "mock",
      kind: "audio",
      ...baseRequest,
    });
  } else if (parsed.provider === "nanobanano" && parsed.kind === "image") {
    result = await provider.generateAsset({
      provider: "nanobanano",
      kind: "image",
      ...baseRequest,
    });
  } else {
    throw new Error(`${parsed.provider} provider does not support ${parsed.kind}.`);
  }

  // The byte filename is a storage key (its own namespace), NOT the DB asset id —
  // Postgres assigns the asset id. Use a random storage name so the bytes can be
  // written before the row exists; self-referential fields (source.generatedAssetId,
  // characterBinding.assetId, semanticAnalysis.id) are patched with the real id
  // after the row is inserted below.
  const storageName = randomUUID();
  const filename = `${storageName}.${result.extension}`;
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

  // assetId is filled in after the DB assigns it (see below); the binding's
  // assetId is patched onto the persisted row.
  const characterBinding: GeneratedAssetCharacterBinding | undefined =
    parsed.characterProfileIds.length > 0
      ? {
          assetId: "",
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
    seed: parsed.seed,
    frameCount: parsed.frameCount,
    fps: parsed.fps,
    steps: parsed.steps,
    guidanceScale: parsed.guidanceScale,
    negativePrompt: parsed.negativePrompt,
    resolution: parsed.resolution,
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
    beatId: parsed.beatId,
    anchorIds: parsed.anchorIds.length ? parsed.anchorIds : undefined,
    characterBinding,
    providerSettings,
    requestedDurationSec: parsed.durationSec,
    actualDurationSec,
  };

  const now = new Date().toISOString();
  const context = parsed.description ? { summary: parsed.description } : undefined;
  const asset: V1Asset = {
    // Placeholder; addAsset omits it on insert and the DB assigns the real id,
    // which is then stamped onto the self-referential fields below.
    id: "",
    schemaVersion: SCHEMA_VERSIONS.asset,
    workspaceId: auth.workspaceId,
    projectId,
    kind: result.kind as AssetKind,
    filename,
    status: "ready",
    source: { type: "generated", generatedAssetId: "" },
    storageKey,
    durationSec,
    context,
    semanticAnalysis: buildSemanticAnalysis({
      // Seed for the in-JSON segment/word ids (exempt in-document keys). The
      // top-level assetId pointer is patched to the DB row id after insert.
      id: storageName,
      kind: result.kind as AssetKind,
      durationSec,
      filename,
      source: { type: "generated" },
      context,
      provenance,
    }),
    provenance,
    createdAt: now,
    updatedAt: now,
  };

  const created = await addAsset(withDerivedAssetKnowledge(asset, now), {
    createdByActionId: action.id,
  });

  // Stamp the DB-generated id onto the asset's self-referential fields (these
  // could not be known before the row existed).
  const updated = await updateAsset(auth.workspaceId, projectId, created.id, (a) => {
    a.source = { type: "generated", generatedAssetId: created.id };
    if (a.semanticAnalysis) a.semanticAnalysis.assetId = created.id;
    if (a.provenance?.characterBinding) {
      a.provenance.characterBinding.assetId = created.id;
    }
  });
  await updateAction(action.id, {
    status: "applied",
    outputAssetIds: [updated.id],
    actualCostUsd: result.costUsd ?? action.estimatedCostUsd,
  });
  return updated;
}

export interface CreateGeneratedAssetArgs {
  auth: AuthContext;
  projectId: string;
  body: unknown;
  // Optional stage handle when this generation runs inside a tracked run. The
  // caller (run orchestrator) is expected to have opened the matching stage
  // (asset_generation for image/video, audio_generation for audio) and to
  // close it once all items for the stage are finished.
  progress?: RunStageHandle;
}

interface GeneratedAssetJobInput {
  body: unknown;
}

const PROMPT_PREVIEW_MAX = 240;

function clipPromptPreview(value: string): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length <= PROMPT_PREVIEW_MAX) return trimmed;
  return `${trimmed.slice(0, PROMPT_PREVIEW_MAX - 1)}…`;
}

export async function createGeneratedAsset(
  args: CreateGeneratedAssetArgs
): Promise<ApiResult> {
  const { auth, projectId, body, progress } = args;
  const job = await enqueueGeneratedAssetJob({ auth, projectId, body });
  const finished = await runGeneratedAssetJob({
    auth,
    projectId,
    jobId: job.id,
    progress,
  });
  if (finished.status === "failed") {
    throw new ApiError(
      (finished.error?.code as ApiErrorCode | undefined) || "job_failed",
      finished.error?.message || "Asset generation failed."
    );
  }
  return { status: 202, body: { job: finished } };
}

export async function enqueueGeneratedAssetJob(
  args: Pick<CreateGeneratedAssetArgs, "auth" | "projectId" | "body">
): Promise<V1Job> {
  const { auth, projectId, body } = args;

  await getProject(auth.workspaceId, projectId); // throws not_found
  parseGeneratedAssetRequest(body);

  return createJob({
    workspaceId: auth.workspaceId,
    projectId,
    type: "asset_generation",
    status: "queued",
    progress: { currentStep: "queued", percent: 0 },
    input: { body } satisfies GeneratedAssetJobInput,
    result: null,
    error: null,
  });
}

function generatedAssetJobInput(job: V1Job): GeneratedAssetJobInput {
  const input = job.input as GeneratedAssetJobInput | null | undefined;
  if (!input || !("body" in input)) {
    throw new ApiError(
      "job_failed",
      `Generated-asset job is missing durable input: ${job.id}.`
    );
  }
  return input;
}

export async function runGeneratedAssetJob(args: {
  auth: AuthContext;
  projectId: string;
  jobId: string;
  progress?: RunStageHandle;
}): Promise<V1Job> {
  const { auth, projectId, jobId, progress } = args;
  await getProject(auth.workspaceId, projectId); // throws not_found

  const job = await getJob(jobId);
  if (
    !job ||
    job.workspaceId !== auth.workspaceId ||
    job.projectId !== projectId ||
    job.type !== "asset_generation"
  ) {
    throw new ApiError("not_found", `Generated-asset job not found: ${jobId}.`);
  }
  if (job.status === "succeeded" || job.status === "failed" || job.status === "canceled") {
    return job;
  }

  const parsed = parseGeneratedAssetRequest(generatedAssetJobInput(job).body);
  const estimatedCostUsd = estimateCostUsd({
    provider: parsed.provider,
    kind: parsed.kind,
    durationSec: parsed.durationSec,
    model: parsed.model,
  });
  const running = await updateJob(job.id, {
    status: "running",
    progress: { currentStep: "generating_assets", percent: 10 },
    error: null,
  });
  let action: V1Action | null = null;
  let item: RunStageItemHandle | null = null;

  try {
    const pinnedFingerprints = await getAssetFingerprintPins(
      projectId,
      parsed.referenceAssetIds
    );
    await assertRunBudgetAllows({
      runId: parsed.runId,
      additionalCostUsd: estimatedCostUsd,
    });
    action = await createAction({
      projectId,
      runId: parsed.runId,
      tool: actionToolForKind(parsed.kind),
      status: "running",
      params: {
        provider: parsed.provider,
        kind: parsed.kind,
        model: parsed.model,
        prompt: parsed.prompt,
        durationSec: parsed.durationSec,
        referenceAssetIds: parsed.referenceAssetIds,
        beatId: parsed.beatId,
        anchorIds: parsed.anchorIds,
      },
      inputAssetIds: parsed.referenceAssetIds,
      rationale: `Generate a ${parsed.kind} asset for the project.`,
      proposal: buildGenerationActionProposal({
        parsed,
        jobId: running.id,
        estimatedCostUsd,
        pinnedFingerprints,
      }),
      estimatedCostUsd,
      jobIds: [running.id],
    });

    // Bind a stage item to this asset so the progress UI can show a per-asset
    // card. The item lives for the duration of this call and is closed before
    // the function returns (success, validation failure, or provider error).
    item = progress
      ? await progress.startItem({
          kind: stageItemKindForAssetKind(parsed.kind),
          label:
            parsed.description ||
            clipPromptPreview(parsed.prompt) ||
            `Generated ${parsed.kind}`,
          provider: parsed.provider,
          promptPreview: clipPromptPreview(parsed.prompt),
        })
      : null;
    if (progress) await progress.attachJob(running.id);

    const asset = await runGeneration(auth, projectId, parsed, item, action);
    const finished = await updateJob(running.id, {
      status: "succeeded",
      progress: { currentStep: "saving_artifact", percent: 100 },
      result: { assetIds: [asset.id] },
      error: null,
    });
    if (item) {
      await item.succeed({
        assetId: asset.id,
        message: `Generated ${parsed.kind}.`,
      });
    }
    return finished;
  } catch (err) {
    const apiErr =
      err instanceof ApiError
        ? err
        : err instanceof Error && /^Run budget exceeded:/.test(err.message)
          ? new ApiError("validation_failed", err.message, {
              reason: "budget_exceeded",
              estimatedCostUsd,
              runId: parsed.runId,
            })
        : new ApiError(
            "job_failed",
            err instanceof Error ? err.message : "Asset generation failed."
          );
    const failed = await updateJob(running.id, {
      status: "failed",
      error: { code: apiErr.code, message: apiErr.message },
    });
    if (action) {
      await updateAction(action.id, {
        status: "failed",
        error: {
          code: apiErr.code,
          message: apiErr.message,
        },
      });
    }
    if (item) {
      await item.fail(
        toErrorSummary(apiErr, { fallbackCode: "job_failed" })
      );
    }
    return failed;
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
