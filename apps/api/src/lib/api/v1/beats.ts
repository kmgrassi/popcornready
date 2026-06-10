// P2: per-beat media tools — POST …/beats/:beatId/{keyframe,clip}.
//
// Thin wrappers over the generic `createGeneratedAsset` primitive (image for a
// keyframe, video for a clip) that ADD per-beat provenance: the `beatId` the
// asset was generated for and the `anchorIds` that conditioned it. Those are
// dependency edges in the provenance graph
// (docs/scopes/north-star-provenance-graph.md) and the foundation for selective
// regeneration (granular-generation-api.md §5 P2).
//
// Design (granular-generation-api.md §6, resolved 2026-06-05):
//  - Uniform async: returns the SAME pollable Job `generated-assets` already
//    returns (reuse its idempotent job + poll), so callers use one client
//    pattern for every stage.
//  - Strict typed precondition errors: a beat clip/keyframe needs *something* to
//    derive a prompt from. If neither an explicit `prompt` nor a `compositionId`
//    (to read the beat's intent from) is supplied, throw a structured
//    `validation_failed` naming exactly what is needed — NORTH_STAR principle 7
//    self-heal. `autocreate: true` opts into deriving a minimal prompt from the
//    beat id instead of erroring.
//  - Thin wrapper: REUSES `createGeneratedAsset` (and its provider pipeline,
//    storage, character binding, preflight, idempotency) verbatim; this module
//    only narrows `kind`, derives the prompt, threads `anchorIds` as reference
//    conditioning, and stamps `{ beatId, anchorIds }` onto the pooled asset's
//    provenance after the job succeeds.

import { AuthContext } from "./auth";
import { ApiError, validationError } from "./errors";
import type { ApiResult } from "./generated-assets";
import {
  createGeneratedAsset as defaultCreateGeneratedAsset,
  enqueueGeneratedAssetJob as defaultEnqueueGeneratedAssetJob,
  getGeneratedAssetJob as defaultGetGeneratedAssetJob,
} from "./generated-assets";
import { V1Job } from "./jobs";
import {
  getCompositionPlan as defaultGetCompositionPlan,
  updateAsset as defaultUpdateAsset,
} from "./store";

// Injectable seams so the unit tests can run without Supabase / real providers
// (mirrors the setXForTests pattern used elsewhere in the API). Defaults are the
// real implementations; production never overrides them.
interface BeatMediaDeps {
  createGeneratedAsset: typeof defaultCreateGeneratedAsset;
  enqueueGeneratedAssetJob: typeof defaultEnqueueGeneratedAssetJob;
  getGeneratedAssetJob: typeof defaultGetGeneratedAssetJob;
  getCompositionPlan: typeof defaultGetCompositionPlan;
  updateAsset: typeof defaultUpdateAsset;
}

let deps: BeatMediaDeps = {
  createGeneratedAsset: defaultCreateGeneratedAsset,
  enqueueGeneratedAssetJob: defaultEnqueueGeneratedAssetJob,
  getGeneratedAssetJob: defaultGetGeneratedAssetJob,
  getCompositionPlan: defaultGetCompositionPlan,
  updateAsset: defaultUpdateAsset,
};

export function setBeatMediaDepsForTests(overrides: Partial<BeatMediaDeps> | null): void {
  const next: BeatMediaDeps = {
    createGeneratedAsset: defaultCreateGeneratedAsset,
    enqueueGeneratedAssetJob: defaultEnqueueGeneratedAssetJob,
    getGeneratedAssetJob: defaultGetGeneratedAssetJob,
    getCompositionPlan: defaultGetCompositionPlan,
    updateAsset: defaultUpdateAsset,
  };
  if (overrides) Object.assign(next, overrides);
  deps = next;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

interface BeatMediaInput {
  prompt?: string;
  compositionId?: string;
  anchorIds: string[];
  autocreate: boolean;
  // Everything else passes through to the generic generator (provider, model,
  // seed, durationSec, characterProfileIds, …) untouched.
  passthrough: Record<string, unknown>;
}

function parseBeatBody(body: unknown): BeatMediaInput {
  const obj = isPlainObject(body) ? body : {};
  const {
    prompt,
    compositionId,
    anchorIds,
    autocreate,
    // `kind` is fixed by the endpoint (image vs video) — never honor a caller
    // override, otherwise a keyframe call could mint a clip.
    kind: _ignoredKind,
    // `referenceAssetIds` is derived from anchorIds below; drop a caller copy so
    // the two channels can't disagree.
    referenceAssetIds: _ignoredRefs,
    ...passthrough
  } = obj;
  return {
    prompt: typeof prompt === "string" && prompt.trim() ? prompt.trim() : undefined,
    compositionId:
      typeof compositionId === "string" && compositionId.trim()
        ? compositionId.trim()
        : undefined,
    anchorIds: parseStringArray(anchorIds),
    autocreate: autocreate === true,
    passthrough,
  };
}

// Resolve the prompt for a beat from the strongest available source, or throw a
// structured precondition error naming what is needed (§6.3).
async function resolvePrompt(
  auth: AuthContext,
  projectId: string,
  beatId: string,
  input: BeatMediaInput,
  mediaKind: "keyframe" | "clip"
): Promise<string> {
  if (input.prompt) return input.prompt;

  if (input.compositionId) {
    const composition = await deps.getCompositionPlan(
      auth.workspaceId,
      projectId,
      input.compositionId
    );
    const beat = composition.plannedBeats.find((b) => b.name === beatId);
    if (!beat) {
      throw new ApiError(
        "not_found",
        `Beat "${beatId}" not found in composition ${input.compositionId}.`,
        { beatId, compositionId: input.compositionId }
      );
    }
    const intent = beat.intent?.trim();
    if (intent) return intent;
  }

  if (input.autocreate) {
    // Convenience escape hatch: synthesize a minimal prompt from the beat id so
    // the caller trades cost-transparency for a one-call generation.
    return `Beat ${beatId}: ${mediaKind === "clip" ? "video clip" : "keyframe"}.`;
  }

  // Self-heal contract: tell the agent exactly which input would satisfy this.
  throw validationError(
    `Cannot generate a beat ${mediaKind}: no prompt to work from.`,
    [
      {
        path: "prompt",
        message:
          "Provide `prompt`, or a `compositionId` whose beat has an `intent`, " +
          "or set `autocreate: true` to derive a prompt from the beat id.",
      },
    ]
  );
}

function jobOf(result: ApiResult): V1Job {
  return result.body.job as V1Job;
}

function assetIdsOf(job: V1Job): string[] {
  const result = job.result as { assetIds?: unknown } | null | undefined;
  return Array.isArray(result?.assetIds) ? (result!.assetIds as string[]) : [];
}

async function buildBeatMediaBody(
  auth: AuthContext,
  projectId: string,
  beatId: string,
  body: unknown,
  mediaKind: "keyframe" | "clip"
): Promise<{ input: BeatMediaInput; generatorBody: Record<string, unknown> }> {
  const input = parseBeatBody(body);
  const prompt = await resolvePrompt(auth, projectId, beatId, input, mediaKind);

  // Thread anchors as reference-asset conditioning for the provider; record them
  // (plus the beatId) as provenance below. Anchors are immutable pooled assets,
  // so they are the upstream dependency edges for this beat asset.
  return {
    input,
    generatorBody: {
      ...input.passthrough,
      kind: mediaKind === "keyframe" ? "image" : "video",
      prompt,
      referenceAssetIds: input.anchorIds,
      beatId,
      anchorIds: input.anchorIds,
    },
  };
}

interface GenerateBeatMediaArgs {
  auth: AuthContext;
  projectId: string;
  beatId: string;
  body: unknown;
}

async function generateBeatMedia(
  args: GenerateBeatMediaArgs,
  mediaKind: "keyframe" | "clip"
): Promise<ApiResult> {
  const { auth, projectId, beatId, body } = args;
  const { input, generatorBody } = await buildBeatMediaBody(
    auth,
    projectId,
    beatId,
    body,
    mediaKind
  );

  const result = await deps.createGeneratedAsset({
    auth,
    projectId,
    body: generatorBody,
  });

  // Stamp per-beat provenance onto every asset the job produced. Best-effort:
  // the generation already succeeded and its Job is the source of truth, so a
  // provenance-write hiccup must not fail the request.
  const job = jobOf(result);
  for (const assetId of assetIdsOf(job)) {
    try {
      await deps.updateAsset(auth.workspaceId, projectId, assetId, (asset) => {
        if (!asset.provenance) return;
        asset.provenance.beatId = beatId;
        if (input.anchorIds.length) asset.provenance.anchorIds = input.anchorIds;
      });
    } catch {
      // Provenance is additive metadata; never let it mask a successful Job.
    }
  }

  return result;
}

export interface BeatMediaRouteArgs {
  auth: AuthContext;
  projectId: string;
  beatId: string;
  body: unknown;
}

export function generateBeatKeyframe(args: BeatMediaRouteArgs): Promise<ApiResult> {
  return generateBeatMedia(args, "keyframe");
}

export function generateBeatClip(args: BeatMediaRouteArgs): Promise<ApiResult> {
  return generateBeatMedia(args, "clip");
}

export async function enqueueBeatClip(args: BeatMediaRouteArgs): Promise<V1Job> {
  const { auth, projectId, beatId, body } = args;
  const { input, generatorBody } = await buildBeatMediaBody(
    auth,
    projectId,
    beatId,
    body,
    "clip"
  );

  return deps.enqueueGeneratedAssetJob({
    auth,
    projectId,
    body: {
      ...generatorBody,
      beatId,
      anchorIds: input.anchorIds,
    },
  });
}

export interface GetBeatMediaJobArgs {
  auth: AuthContext;
  projectId: string;
  jobId: string;
}

// Beat-scoped poll companion: a per-beat media job IS an `asset_generation`
// job, so reuse the generated-assets poll verbatim (uniform job/poll, §6.2).
export function getBeatMediaJob(args: GetBeatMediaJobArgs): Promise<ApiResult> {
  return deps.getGeneratedAssetJob(args);
}
