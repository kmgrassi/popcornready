import { createHash } from "crypto";
import { critique as realCritique, planEdit as realPlanEdit, selectClips as realSelectClips } from "../agent";
import { applyPatches, sanitizeTimeline } from "../timeline";
import { mergeStoryContext } from "../story-context";
import { Clip, StoryContext } from "../types";
import { Actor } from "./actor";
import { ApiError, ErrorCode } from "./errors";
import * as ids from "./ids";
import { V1Store } from "./store";
import {
  BriefVersion,
  CompositionPlan,
  GenerationJob,
  GenerationJobInput,
  GenerationRequest,
  SCHEMA,
  V1Asset,
  VersionedTimeline,
  VideoBriefInput,
} from "./types";

// PR4 — timeline generation from agent inputs.
//
// The route layer is intentionally thin: it validates + resolves a request
// (prepareGeneration), creates a job (createGenerationJob), then runs the job
// (runGenerationJob). The model-backed plan/select/critique calls are injected
// so the executor can be exercised deterministically and offline in tests.

// --- Mapping helpers -------------------------------------------------------

export function briefToStoryContext(brief: VideoBriefInput): StoryContext {
  const partial: StoryContext = {};
  if (brief.audience) partial.audience = brief.audience;
  if (brief.platform) partial.platform = brief.platform;
  if (brief.format) partial.format = brief.format;
  if (brief.constraints?.callToAction) {
    partial.callToAction = brief.constraints.callToAction;
  }
  return mergeStoryContext(partial);
}

// The agent layer reasons over MVP Clips; map a v1 asset onto that shape.
export function assetToClip(asset: V1Asset): Clip {
  return {
    id: asset.id,
    filename: asset.filename,
    url: asset.url,
    kind: asset.kind,
    durationSec: asset.durationSec,
    description: asset.description || "",
    source: asset.source === "generated" ? "generated" : "upload",
  };
}

// --- Validation / resolution ----------------------------------------------

export async function prepareGeneration(
  store: V1Store,
  projectId: string,
  body: GenerationRequest
): Promise<GenerationJobInput> {
  const project = await store.getProject(projectId);
  if (!project || project.status === "deleted") {
    throw new ApiError("not_found", `Project not found: ${projectId}`);
  }

  const briefVersionId = String(body.briefVersionId || "").trim();
  if (!briefVersionId) {
    throw new ApiError("brief_missing", "briefVersionId is required.", {
      fields: [{ path: "briefVersionId", message: "Required." }],
    });
  }
  const brief = await store.getBriefVersion(briefVersionId);
  if (!brief || brief.projectId !== projectId) {
    throw new ApiError("not_found", `Brief version not found: ${briefVersionId}`);
  }

  const variantCount = body.variantCount === undefined ? 1 : Number(body.variantCount);
  if (!Number.isInteger(variantCount) || variantCount < 1) {
    throw new ApiError("validation_failed", "variantCount must be a positive integer.", {
      fields: [{ path: "variantCount", message: "Must be an integer >= 1." }],
    });
  }
  if (variantCount > 1) {
    throw new ApiError(
      "validation_failed",
      "Multi-variant generation is not supported in v1; variantCount must be 1.",
      { fields: [{ path: "variantCount", message: "Only 1 is supported in v1." }] }
    );
  }

  const requestedAssetIds: string[] = Array.isArray(body.assetIds)
    ? body.assetIds.map((id) => String(id))
    : [];
  const compositionId = body.compositionId ? String(body.compositionId) : undefined;

  let composition: CompositionPlan | null = null;
  if (compositionId) {
    composition = await store.getComposition(compositionId);
    if (!composition || composition.projectId !== projectId) {
      throw new ApiError("not_found", `Composition not found: ${compositionId}`);
    }
    // The composition must have been planned for this exact brief version,
    // otherwise its generated assets and the timeline plan would come from
    // different briefs and the stored provenance would mislink them.
    if (composition.briefVersionId !== briefVersionId) {
      throw new ApiError(
        "validation_failed",
        `Composition ${compositionId} was planned for a different brief version (${composition.briefVersionId}).`,
        {
          fields: [
            {
              path: "compositionId",
              message: "Composition brief version does not match briefVersionId.",
            },
          ],
        }
      );
    }
  }

  let assetIds: string[];
  if (requestedAssetIds.length > 0) {
    // Asset-driven or hybrid: the agent supplies the asset set explicitly.
    assetIds = requestedAssetIds;
  } else if (composition) {
    // Prompt-only: assetIds may be empty only when the composition is done.
    if (composition.status !== "ready_for_timeline") {
      throw new ApiError(
        "validation_failed",
        `Composition ${compositionId} is not ready for timeline (status: ${composition.status}).`
      );
    }
    if (composition.readyAssetIds.length === 0) {
      throw new ApiError(
        "validation_failed",
        `Composition ${compositionId} has no ready assets to build a timeline from.`
      );
    }
    assetIds = composition.readyAssetIds;
  } else {
    throw new ApiError(
      "validation_failed",
      "assetIds is required unless compositionId points to a completed composition.",
      { fields: [{ path: "assetIds", message: "Provide assetIds or a ready compositionId." }] }
    );
  }

  // Every selected asset must exist, belong to the project, and be ready.
  const resolved: V1Asset[] = [];
  for (const id of assetIds) {
    const asset = await store.getAsset(id);
    if (!asset || asset.projectId !== projectId) {
      throw new ApiError("asset_invalid", `Asset not found in project: ${id}`, {
        fields: [{ path: "assetIds", message: `Unknown asset: ${id}` }],
      });
    }
    if (asset.status !== "ready") {
      throw new ApiError("asset_not_ready", `Asset ${id} is not ready (status: ${asset.status}).`, {
        fields: [{ path: "assetIds", message: `Asset ${id} is ${asset.status}.` }],
      });
    }
    resolved.push(asset);
  }

  // Clip selection needs at least one ready visual (video/image) asset.
  if (resolved.filter((a) => a.kind !== "audio").length === 0) {
    throw new ApiError(
      "validation_failed",
      "At least one ready video or image asset is required to build a timeline."
    );
  }

  const generatedAssetJobIds = new Set<string>(composition?.generatedAssetJobIds ?? []);
  for (const asset of resolved) {
    if (asset.generatedAssetJobId) generatedAssetJobIds.add(asset.generatedAssetJobId);
  }

  return {
    briefVersionId,
    ...(compositionId ? { compositionId } : {}),
    assetIds,
    generatedAssetJobIds: [...generatedAssetJobIds],
    variantCount,
  };
}

// --- Idempotency -----------------------------------------------------------

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function idempotencyScope(actor: Actor, projectId: string, key: string): string {
  return sha256(
    `${actor.workspaceId}|POST|/api/v1/projects/${projectId}/generations|${key}`
  );
}

// Canonical hash of the original request body. Idempotency compares the
// request a client sent, not the resolved inputs — resolved inputs depend on
// mutable asset/composition state that may change between retries, and a retry
// after network loss must replay the original job regardless.
function requestBodyHash(body: GenerationRequest): string {
  return sha256(
    JSON.stringify({
      briefVersionId: body.briefVersionId ?? null,
      compositionId: body.compositionId ?? null,
      assetIds: Array.isArray(body.assetIds) ? body.assetIds.map((id) => String(id)) : [],
      variantCount: body.variantCount ?? 1,
      audioAlignment: body.audioAlignment ?? null,
    })
  );
}

// --- Job creation ----------------------------------------------------------

function buildJob(
  actor: Actor,
  projectId: string,
  input: GenerationJobInput,
  idempotencyKey?: string
): GenerationJob {
  const now = new Date().toISOString();
  return {
    id: ids.jobId(),
    schemaVersion: SCHEMA.job,
    workspaceId: actor.workspaceId,
    projectId,
    type: "generation",
    status: "queued",
    progress: { currentStep: "validating_request", percent: 0 },
    input,
    result: null,
    error: null,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

export async function createGenerationJob(args: {
  store: V1Store;
  actor: Actor;
  projectId: string;
  body: GenerationRequest;
  idempotencyKey?: string;
}): Promise<GenerationJob> {
  const { store, actor, projectId, body, idempotencyKey } = args;

  if (idempotencyKey) {
    const scope = idempotencyScope(actor, projectId, idempotencyKey);
    const requestHash = requestBodyHash(body);
    const existing = await store.getIdempotency(scope);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new ApiError(
          "idempotency_conflict",
          "Idempotency-Key was reused with a different request body."
        );
      }
      // Same key + same body: replay the original job without re-validating
      // or re-resolving, so changed asset/composition state can't turn a retry
      // into a spurious error.
      const prior = (await store.getJob(existing.jobId)) as GenerationJob | null;
      if (prior) return prior;
      // Record exists but the job is gone — fall through and recreate it.
    }
    const input = await prepareGeneration(store, projectId, body);
    const job = buildJob(actor, projectId, input, idempotencyKey);
    await store.saveJob(job);
    await store.saveIdempotency(scope, {
      requestHash,
      jobId: job.id,
      createdAt: new Date().toISOString(),
    });
    return job;
  }

  const input = await prepareGeneration(store, projectId, body);
  const job = buildJob(actor, projectId, input);
  await store.saveJob(job);
  return job;
}

// --- Execution -------------------------------------------------------------

export interface GenerationDeps {
  planEdit: typeof realPlanEdit;
  selectClips: typeof realSelectClips;
  critique: typeof realCritique;
}

const defaultDeps: GenerationDeps = {
  planEdit: realPlanEdit,
  selectClips: realSelectClips,
  critique: realCritique,
};

async function saveJobUpdate(
  store: V1Store,
  job: GenerationJob,
  changes: Partial<Pick<GenerationJob, "status" | "progress" | "result" | "error">>
): Promise<GenerationJob> {
  const next: GenerationJob = {
    ...job,
    ...changes,
    progress: changes.progress ? { ...job.progress, ...changes.progress } : job.progress,
    updatedAt: new Date().toISOString(),
  };
  await store.saveJob(next);
  return next;
}

function failJob(
  store: V1Store,
  job: GenerationJob,
  code: ErrorCode,
  message: string
): Promise<GenerationJob> {
  return saveJobUpdate(store, job, { status: "failed", error: { code, message } });
}

export async function runGenerationJob(
  store: V1Store,
  jobId: string,
  deps: GenerationDeps = defaultDeps
): Promise<GenerationJob> {
  const loaded = (await store.getJob(jobId)) as GenerationJob | null;
  if (!loaded) throw new ApiError("not_found", `Job not found: ${jobId}`);
  // Terminal/already-running jobs are not re-executed (idempotent worker claim).
  if (loaded.status !== "queued") return loaded;

  let job = await saveJobUpdate(store, loaded, {
    status: "running",
    progress: { currentStep: "validating_request", percent: 5 },
  });

  const input = loaded.input;
  if (!input) return failJob(store, job, "internal_error", "Generation job has no resolved input.");

  try {
    const brief = await store.getBriefVersion(input.briefVersionId);
    if (!brief) {
      return failJob(store, job, "brief_missing", `Brief version not found: ${input.briefVersionId}`);
    }

    const assets: V1Asset[] = [];
    for (const id of input.assetIds) {
      const asset = await store.getAsset(id);
      if (!asset) return failJob(store, job, "asset_invalid", `Asset disappeared: ${id}`);
      if (asset.status !== "ready") {
        return failJob(store, job, "asset_not_ready", `Asset ${id} is no longer ready.`);
      }
      assets.push(asset);
    }

    const clips = assets.map(assetToClip);
    const storyContext = briefToStoryContext(brief.brief);

    job = await saveJobUpdate(store, job, {
      progress: { currentStep: "planning_timeline", percent: 20 },
    });
    const plan = await deps.planEdit({
      goal: brief.brief.goal,
      targetLengthSec: brief.brief.targetLengthSec,
      style: brief.brief.style || "fast-paced social ad",
      aspectRatio: brief.brief.aspectRatio,
      storyContext,
    });

    job = await saveJobUpdate(store, job, {
      progress: { currentStep: "selecting_clips", percent: 50 },
    });
    let timeline = sanitizeTimeline(await deps.selectClips({ plan, clips }), clips);

    job = await saveJobUpdate(store, job, {
      progress: { currentStep: "critiquing_timeline", percent: 75 },
    });
    const { report, patches } = await deps.critique({ plan, timeline, clips, storyContext });
    timeline = applyPatches(timeline, patches, clips);

    if (timeline.segments.length === 0) {
      return failJob(store, job, "timeline_invalid", "Generated timeline has no valid segments.");
    }

    job = await saveJobUpdate(store, job, {
      progress: { currentStep: "saving_artifact", percent: 90 },
    });
    const now = new Date().toISOString();
    const versioned: VersionedTimeline = {
      id: ids.timelineId(),
      schemaVersion: SCHEMA.timeline,
      projectId: job.projectId,
      briefVersionId: input.briefVersionId,
      ...(input.compositionId ? { compositionId: input.compositionId } : {}),
      aspectRatio: timeline.aspectRatio,
      fps: timeline.fps,
      segments: timeline.segments,
      provenance: {
        briefVersionId: input.briefVersionId,
        ...(input.compositionId ? { compositionId: input.compositionId } : {}),
        sourceAssetIds: input.assetIds,
        generatedAssetJobIds: input.generatedAssetJobIds,
        criticReport: report,
        appliedPatchCount: patches.length,
      },
      createdBy: { jobId: job.id },
      createdAt: now,
    };
    await store.saveTimeline(versioned);

    return saveJobUpdate(store, job, {
      status: "succeeded",
      progress: { currentStep: "saving_artifact", percent: 100 },
      result: { timelineIds: [versioned.id] },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Generation failed.";
    let code: ErrorCode = "internal_error";
    if (err instanceof ApiError) code = err.code;
    else if (message.includes("did not return valid JSON")) code = "model_output_invalid";
    return failJob(store, job, code, message);
  }
}
