import { critique as realCritique, planEdit as realPlanEdit, selectClips as realSelectClips } from "../agent";
import {
  EDIT_GRAPH_COMPILER_VERSION,
  buildEditGraphFromTimeline,
  compileEditGraphToTimeline,
  markGraphTimelineProjection,
} from "@popcorn/shared/edit-graph";
import { applyPatches, sanitizeTimeline } from "@popcorn/timeline/timeline";
import { ApiError, ErrorCode } from "./errors";
import {
  RunProgressEmitter,
  RunStageHandle,
  noopProgressEmitter,
  toErrorSummary,
} from "./generation-progress";
import { isRunReviewGatePaused } from "./generation-runs";
import * as ids from "./ids";
import { Logger, createLogger } from "./logger";
import { redactMessage } from "./redact";
import { V1Store } from "./store";
import {
  GenerationJob,
  GenerationStageItem,
  GenerationStageType,
  SCHEMA,
  V1Asset,
  VersionedTimeline,
} from "@popcorn/shared/v1/types";
import { assetToClip, briefToStoryContext } from "./generation/prepare";

// PR4 — timeline generation from agent inputs.
//
// The route layer is intentionally thin: it validates + resolves a request
// (prepareGeneration), creates a job (createGenerationJob), then runs the job
// (runGenerationJob). The model-backed plan/select/critique calls are injected
// so the executor can be exercised deterministically and offline in tests.

export { createGenerationJob } from "./generation/create-job";
export { assetToClip, briefToStoryContext, prepareGeneration } from "./generation/prepare";

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

// Persists a stage's output as a first-class addressable artifact and returns
// its id, so an evaluator can read it as evidence after the stage succeeds
// (Stage Eval Framework §3 "Evidence-bearing hook"). Supplied by the caller
// (the run model / route) so generation.ts stays decoupled from the runs store.
export type StageArtifactPersister = (input: {
  stageType: GenerationStageType;
  kind: GenerationStageItem["kind"];
  content: unknown;
}) => Promise<{ artifactId: string }>;

// Opt-in bounded-execution controls (Stage Eval Framework §3, NORTH_STAR
// principle 2). The autonomous production default leaves both unset.
export interface RunExecutionOptions {
  // Halt after this stage and await an explicit continue (a debug/test
  // breakpoint). Reuses the reviewGate pause: the run sits paused, a resume
  // re-enters runGenerationJob. Unset = autonomous run.
  stopAfter?: GenerationStageType;
  // Dry-run depth: run plan + per-asset prompt construction + preflight, but
  // STOP before any provider/media call (clip selection / assembly). Produces
  // the specs without media spend. The workbench default (§6C).
  promptsOnly?: boolean;
  // Persists each stage's output as an addressable artifact (see above). When
  // omitted, stages succeed without a result artifact (legacy text stages had
  // nothing to evaluate).
  persistStageArtifact?: StageArtifactPersister;
}

// Internal control-flow signal: a bounded-execution stop (stopAfter /
// prompts_only) was hit. Carried out of the executor like a review-gate pause so
// the worker halts cleanly and the run can be resumed.
export class RunBoundedStop extends Error {
  readonly stageType: GenerationStageType;
  readonly reason: "stop_after" | "prompts_only";
  constructor(stageType: GenerationStageType, reason: "stop_after" | "prompts_only") {
    super(`Generation run halted (${reason}) after ${stageType}.`);
    this.name = "RunBoundedStop";
    this.stageType = stageType;
    this.reason = reason;
  }
}

export function isRunBoundedStop(err: unknown): err is RunBoundedStop {
  return err instanceof RunBoundedStop;
}

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
  progressOrLogger: Logger | RunProgressEmitter = noopProgressEmitter,
  execution: RunExecutionOptions = {}
): Promise<GenerationJob> {
  const loaded = (await store.getJob(jobId)) as GenerationJob | null;
  if (!loaded) throw new ApiError("not_found", `Job not found: ${jobId}`);
  // Terminal/already-running jobs are not re-executed (idempotent worker claim).
  if (loaded.status !== "queued") return loaded;

  const persistStageArtifact = execution.persistStageArtifact;
  const stopAfter = execution.stopAfter;
  const promptsOnly = execution.promptsOnly === true;

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

  // Bounded-execution breakpoint: after the just-succeeded stage, halt if the
  // caller set `stopAfter` to it, or if `prompts_only` stops before the first
  // provider/media work. Throwing RunBoundedStop unwinds to the same paused
  // handling as a review gate. Call AFTER `stage.succeed()` so the artifact is
  // persisted and any blocking judge has run.
  const haltAfterIfRequested = (stageType: GenerationStageType): void => {
    if (stopAfter === stageType) {
      throw new RunBoundedStop(stageType, "stop_after");
    }
  };

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
    // Persist the plan as a first-class addressable artifact and carry its id on
    // succeed() so the inline judge can read it as evidence (§3).
    const planArtifact = persistStageArtifact
      ? await persistStageArtifact({
          stageType: "creative_plan",
          kind: "timeline",
          content: plan,
        })
      : undefined;
    await activeStage.succeed(
      planArtifact ? { resultArtifactId: planArtifact.artifactId } : undefined
    );
    activeStage = null;

    // Bounded execution: prompts_only stops here — the plan/specs are produced
    // without any clip selection / assembly (the first media-ward work). An
    // explicit `stopAfter: creative_plan` breakpoint halts here too.
    if (promptsOnly) {
      throw new RunBoundedStop("creative_plan", "prompts_only");
    }
    haltAfterIfRequested("creative_plan");

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
      timeline = sanitizeTimeline(
        await deps.selectClips({
          plan,
          clips,
          goal: brief.brief.goal,
          storyContext,
        }),
        clips
      );
    } catch (err) {
      const summary = toErrorSummary(err, { fallbackCode: "internal_error" });
      await timelineItem.fail(summary);
      throw err;
    }
    // Persist the assembled timeline draft as the item's and stage's result
    // artifact so the timeline_assembly evaluator has evidence to judge (§3).
    const timelineArtifact = persistStageArtifact
      ? await persistStageArtifact({
          stageType: "timeline_assembly",
          kind: "timeline",
          content: timeline,
        })
      : undefined;
    await timelineItem.succeed(
      timelineArtifact ? { artifactId: timelineArtifact.artifactId } : undefined
    );
    await activeStage.succeed(
      timelineArtifact ? { resultArtifactId: timelineArtifact.artifactId } : undefined
    );
    activeStage = null;
    haltAfterIfRequested("timeline_assembly");

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
    const timelineForGraph =
      input.showCaptions === undefined
        ? timeline
        : { ...timeline, showCaptions: input.showCaptions };
    const editGraph = buildEditGraphFromTimeline({
      id: ids.editGraphId(),
      projectId: job.projectId,
      briefVersionId: input.briefVersionId,
      ...(input.compositionId ? { compositionId: input.compositionId } : {}),
      jobId: job.id,
      goal: brief.brief.goal,
      storyContext,
      plan,
      clips,
      timeline: timelineForGraph,
      createdAt: now,
    });
    const compiledTimeline = compileEditGraphToTimeline(editGraph);
    const versioned: VersionedTimeline = {
      id: ids.timelineId(),
      schemaVersion: SCHEMA.timeline,
      projectId: job.projectId,
      briefVersionId: input.briefVersionId,
      ...(input.compositionId ? { compositionId: input.compositionId } : {}),
      aspectRatio: compiledTimeline.aspectRatio,
      fps: compiledTimeline.fps,
      ...(input.showCaptions === undefined ? {} : { showCaptions: input.showCaptions }),
      segments: compiledTimeline.segments,
      provenance: {
        briefVersionId: input.briefVersionId,
        ...(input.compositionId ? { compositionId: input.compositionId } : {}),
        sourceAssetIds: input.assetIds,
        generatedAssetJobIds: input.generatedAssetJobIds,
        criticReport: report,
        appliedPatchCount: patches.length,
      },
      derivedFrom: {
        editGraphId: editGraph.id,
        compilerVersion: EDIT_GRAPH_COMPILER_VERSION,
        compiledAt: now,
      },
      createdBy: { jobId: job.id },
      createdAt: now,
    };
    await store.saveEditGraph(markGraphTimelineProjection(editGraph, versioned.id, now));
    await store.saveTimeline(versioned);

    const finished = await saveJobUpdate(
      store,
      job,
      {
        status: "succeeded",
        progress: { currentStep: "saving_artifact", percent: 100 },
        result: { timelineIds: [versioned.id], editGraphIds: [editGraph.id] },
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
    if (isRunBoundedStop(err)) {
      logger.info("job.halted", {
        stageType: err.stageType,
        reason: err.reason,
      });
      // A bounded-execution stop (stopAfter / prompts_only) halts the worker the
      // same way a review-gate pause does: the run/job sits paused. Roll the job
      // back to `queued` so an explicit continue can dispatch it again (resume
      // re-enters runGenerationJob, which only picks up `queued` jobs).
      return saveJobUpdate(store, job, { status: "queued" }, logger);
    }
    if (isRunReviewGatePaused(err)) {
      logger.info("job.paused_for_review", {
        stageType: err.stageType,
        stageId: err.stageId,
      });
      // The worker has stopped at a review gate, but the pause is a run-level
      // concept (`run.reviewGate`) — the backing job is no longer executing.
      // Leaving it `running` would strand it forever, since resume re-enters
      // through `runGenerationJob`, which only picks up `queued` jobs. Roll the
      // job back to `queued` so an approve can dispatch it again.
      return saveJobUpdate(store, job, { status: "queued" }, logger);
    }

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
