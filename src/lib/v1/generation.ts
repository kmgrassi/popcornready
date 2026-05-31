import { createHash } from "crypto";
import { critique as realCritique, planEdit as realPlanEdit, selectClips as realSelectClips } from "../agent";
import { applyPatches, sanitizeTimeline } from "../timeline";
import { mergeStoryContext } from "../story-context";
import { Clip, StoryContext } from "../types";
import { Actor } from "./actor";
import { ApiError, ErrorCode } from "./errors";
import {
  RunProgressEmitter,
  RunStageHandle,
  noopProgressEmitter,
  toErrorSummary,
} from "./generation-progress";
import * as ids from "./ids";
import { Logger, createLogger } from "./logger";
import { redactMessage } from "./redact";
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

  const showCaptions = body.showCaptions;
  if (showCaptions !== undefined && typeof showCaptions !== "boolean") {
    throw new ApiError("validation_failed", "showCaptions must be a boolean.", {
      fields: [{ path: "showCaptions", message: "Must be true or false." }],
    });
  }

  return {
    briefVersionId,
    ...(compositionId ? { compositionId } : {}),
    assetIds,
    generatedAssetJobIds: [...generatedAssetJobIds],
    ...(showCaptions === undefined ? {} : { showCaptions }),
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
      showCaptions: body.showCaptions ?? null,
    })
  );
}

// --- Job creation ----------------------------------------------------------

function buildJob(
  actor: Actor,
  projectId: string,
  input: GenerationJobInput,
  options: { idempotencyKey?: string; requestId?: string }
): GenerationJob {
  const now = new Date().toISOString();
  return {
    id: ids.jobId(),
    schemaVersion: SCHEMA.job,
    workspaceId: actor.workspaceId,
    projectId,
    ...(options.requestId ? { requestId: options.requestId } : {}),
    type: "generation",
    status: "queued",
    progress: { currentStep: "validating_request", stepStartedAt: now, percent: 0 },
    input,
    result: null,
    error: null,
    ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
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
  requestId?: string;
  logger?: Logger;
}): Promise<GenerationJob> {
  const { store, actor, projectId, body, idempotencyKey, requestId } = args;
  const logger =
    args.logger ??
    createLogger({
      requestId,
      workspaceId: actor.workspaceId,
      projectId,
      jobType: "generation",
    });

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
      if (prior) {
        logger.info("job.replayed", { jobId: prior.id, idempotencyKey });
        return prior;
      }
      // Record exists but the job is gone — fall through and recreate it.
    }
    const input = await prepareGeneration(store, projectId, body);
    const job = buildJob(actor, projectId, input, { idempotencyKey, requestId });
    await store.saveJob(job);
    await store.saveIdempotency(scope, {
      requestHash,
      jobId: job.id,
      createdAt: new Date().toISOString(),
    });
    logger.info("job.created", { jobId: job.id, idempotent: true });
    return job;
  }

  const input = await prepareGeneration(store, projectId, body);
  const job = buildJob(actor, projectId, input, { requestId });
  await store.saveJob(job);
  logger.info("job.created", { jobId: job.id, idempotent: false });
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
  changes: Partial<Pick<GenerationJob, "status" | "progress" | "result" | "error">>,
  logger?: Logger
): Promise<GenerationJob> {
  const now = new Date().toISOString();
  let progress = job.progress;
  if (changes.progress) {
    progress = { ...job.progress, ...changes.progress };
    const incomingStep = changes.progress.currentStep;
    const stepChanged =
      incomingStep !== undefined && incomingStep !== job.progress.currentStep;
    if (stepChanged) {
      const prevStartedAt = job.progress.stepStartedAt;
      const previousStep = job.progress.currentStep;
      progress.stepStartedAt = now;
      if (logger) {
        const durationMs =
          prevStartedAt && previousStep
            ? Date.parse(now) - Date.parse(prevStartedAt)
            : undefined;
        logger.info("job.step.started", {
          step: incomingStep,
          percent: progress.percent,
          ...(previousStep ? { previousStep } : {}),
          ...(typeof durationMs === "number" ? { previousStepDurationMs: durationMs } : {}),
        });
      }
    }
  }
  const next: GenerationJob = {
    ...job,
    ...changes,
    progress,
    updatedAt: now,
  };
  await store.saveJob(next);
  return next;
}

async function failJob(
  store: V1Store,
  job: GenerationJob,
  code: ErrorCode,
  message: string,
  logger?: Logger
): Promise<GenerationJob> {
  const next = await saveJobUpdate(
    store,
    job,
    { status: "failed", error: { code, message } },
    logger
  );
  if (logger) {
    const durationMs = Date.parse(next.updatedAt) - Date.parse(next.createdAt);
    logger.error("job.failed", {
      durationMs,
      error: { code, message },
    });
  }
  return next;
}

// Fail the underlying job AND roll the current run stage to `failed` with a
// matching error summary, so the run UI reflects the same termination as the
// job record. The stage parameter is optional because failures can land before
// any stage has been opened (e.g. structural validation).
async function failJobAndStage(
  store: V1Store,
  job: GenerationJob,
  code: ErrorCode,
  message: string,
  stage: RunStageHandle | null,
  logger?: Logger
): Promise<GenerationJob> {
  if (stage) await stage.fail({ code, message, retryable: false });
  return failJob(store, job, code, message, logger);
}

export async function runGenerationJob(
  store: V1Store,
  jobId: string,
  deps: GenerationDeps = defaultDeps,
  progressOrLogger: Logger | RunProgressEmitter = noopProgressEmitter
): Promise<GenerationJob> {
  const loaded = (await store.getJob(jobId)) as GenerationJob | null;
  if (!loaded) throw new ApiError("not_found", `Job not found: ${jobId}`);
  // Terminal/already-running jobs are not re-executed (idempotent worker claim).
  if (loaded.status !== "queued") return loaded;

  const isProgressEmitter =
    typeof progressOrLogger === "object" &&
    progressOrLogger !== null &&
    "beginStage" in progressOrLogger &&
    "updateRun" in progressOrLogger;
  const progress = isProgressEmitter
    ? (progressOrLogger as RunProgressEmitter)
    : noopProgressEmitter;
  const parentLogger = isProgressEmitter
    ? undefined
    : (progressOrLogger as Logger | undefined);

  const logger = (parentLogger ?? createLogger()).child({
    requestId: loaded.requestId,
    workspaceId: loaded.workspaceId,
    projectId: loaded.projectId,
    jobId: loaded.id,
    jobType: loaded.type,
  });

  logger.info("job.run.started");

  let job = await saveJobUpdate(
    store,
    loaded,
    {
      status: "running",
      progress: { currentStep: "validating_request", percent: 5 },
    },
    logger
  );

  // Track the active stage so a failure mid-flight can roll it (and only it)
  // to a `failed` terminal state.
  let activeStage: RunStageHandle | null = null;

  try {
    await progress.updateRun({ progressPercent: 5, message: "Validating request" });

    const input = loaded.input;
    if (!input) {
      return failJobAndStage(
        store,
        job,
        "internal_error",
        "Generation job has no resolved input.",
        null,
        logger
      );
    }

    const brief = await store.getBriefVersion(input.briefVersionId);
    if (!brief) {
      return failJobAndStage(
        store,
        job,
        "brief_missing",
        `Brief version not found: ${input.briefVersionId}`,
        null,
        logger
      );
    }

    const assets: V1Asset[] = [];
    for (const id of input.assetIds) {
      const asset = await store.getAsset(id);
      if (!asset) {
        return failJobAndStage(
          store,
          job,
          "asset_invalid",
          `Asset disappeared: ${id}`,
          null,
          logger
        );
      }
      if (asset.status !== "ready") {
        return failJobAndStage(
          store,
          job,
          "asset_not_ready",
          `Asset ${id} is no longer ready.`,
          null,
          logger
        );
      }
      assets.push(asset);
    }

    const clips = assets.map(assetToClip);
    const storyContext = briefToStoryContext(brief.brief);
    // planEdit/selectClips/critique are Anthropic-backed agent calls; pin the
    // provider field on the logger so step timing and any caught errors
    // surface with that context.
    const modelLogger = logger.child({ provider: "anthropic" });

    // creative_plan: convert the brief into a beat-level plan.
    job = await saveJobUpdate(
      store,
      job,
      {
        progress: { currentStep: "planning_timeline", percent: 20 },
      },
      modelLogger
    );
    activeStage = await progress.beginStage("creative_plan", {
      label: "Planning the cut",
      message: `Planning a ${brief.brief.targetLengthSec}-second video.`,
    });
    await activeStage.attachJob(job.id);
    await progress.updateRun({ progressPercent: 20, message: "Planning the cut" });
    const plan = await deps.planEdit({
      goal: brief.brief.goal,
      targetLengthSec: brief.brief.targetLengthSec,
      style: brief.brief.style || "fast-paced social ad",
      aspectRatio: brief.brief.aspectRatio,
      storyContext,
    });
    await activeStage.succeed();

    // timeline_assembly: select clips and build the timeline segments.
    job = await saveJobUpdate(
      store,
      job,
      {
        progress: { currentStep: "selecting_clips", percent: 50 },
      },
      modelLogger
    );
    activeStage = await progress.beginStage("timeline_assembly", {
      label: "Assembling the timeline",
      message: "Selecting clips for each beat.",
    });
    await activeStage.attachJob(job.id);
    await progress.updateRun({ progressPercent: 50, message: "Assembling the timeline" });
    const timelineItem = await activeStage.startItem({
      kind: "timeline",
      label: "Timeline draft",
    });
    let timeline: ReturnType<typeof sanitizeTimeline>;
    try {
      timeline = sanitizeTimeline(await deps.selectClips({ plan, clips }), clips);
    } catch (err) {
      const summary = toErrorSummary(err, { fallbackCode: "internal_error" });
      await timelineItem.fail(summary);
      throw err;
    }
    await timelineItem.succeed();
    await activeStage.succeed();

    // quality_review: critique the draft timeline and apply patches.
    job = await saveJobUpdate(
      store,
      job,
      {
        progress: { currentStep: "critiquing_timeline", percent: 75 },
      },
      modelLogger
    );
    activeStage = await progress.beginStage("quality_review", {
      label: "Reviewing the cut",
      message: "Checking pacing, clarity, and coverage.",
    });
    await activeStage.attachJob(job.id);
    await progress.updateRun({ progressPercent: 75, message: "Reviewing the cut" });

    const { report, patches } = await deps.critique({ plan, timeline, clips, storyContext });
    timeline = applyPatches(timeline, patches, clips);

    if (timeline.segments.length === 0) {
      return failJobAndStage(
        store,
        job,
        "timeline_invalid",
        "Generated timeline has no valid segments.",
        activeStage,
        logger
      );
    }
    await activeStage.succeed({
      message: `Applied ${patches.length} revision${patches.length === 1 ? "" : "s"}.`,
    });
    activeStage = null;

    job = await saveJobUpdate(
      store,
      job,
      {
        progress: { currentStep: "saving_artifact", percent: 90 },
      },
      logger
    );
    await progress.updateRun({ progressPercent: 90, message: "Saving the timeline." });
    const now = new Date().toISOString();
    const versioned: VersionedTimeline = {
      id: ids.timelineId(),
      schemaVersion: SCHEMA.timeline,
      projectId: job.projectId,
      briefVersionId: input.briefVersionId,
      ...(input.compositionId ? { compositionId: input.compositionId } : {}),
      aspectRatio: timeline.aspectRatio,
      fps: timeline.fps,
      ...(input.showCaptions === undefined ? {} : { showCaptions: input.showCaptions }),
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

    const finished = await saveJobUpdate(
      store,
      job,
      {
        status: "succeeded",
        progress: { currentStep: "saving_artifact", percent: 100 },
        result: { timelineIds: [versioned.id] },
      },
      logger
    );
    await progress.updateRun({ progressPercent: 100, message: "Timeline ready." });
    const totalMs = Date.parse(finished.updatedAt) - Date.parse(finished.createdAt);
    logger.info("job.succeeded", {
      durationMs: totalMs,
      timelineId: versioned.id,
    });
    return finished;
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : "Generation failed.";
    let code: ErrorCode = "internal_error";
    if (err instanceof ApiError) code = err.code;
    else if (rawMessage.includes("did not return valid JSON")) code = "model_output_invalid";
    // Redact before persisting so any provider response leaking into the error
    // message (Authorization headers, raw upstream JSON bodies) never lands in
    // the job record or the API response.
    const message = redactMessage(rawMessage);
    return failJobAndStage(store, job, code, message, activeStage, logger);
  }
}
