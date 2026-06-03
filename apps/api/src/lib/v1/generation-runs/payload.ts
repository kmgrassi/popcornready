import { ApiError } from "../errors";
import {
  GATEABLE_GENERATION_STAGE_TYPES,
  GENERATION_STAGE_LABELS,
  GateableGenerationStageType,
  GenerationRun,
  GenerationRunStatus,
  GenerationStage,
  GenerationStageItem,
  GenerationStageType,
} from "@popcorn/shared/v1/types";
import { ACTIVE_RUN_STATUSES, TERMINAL_RUN_STATUSES } from "./status";
import { GenerationRunsStore } from "./store";

// --- API helpers -----------------------------------------------------------

export interface GenerationRunPayload {
  run: GenerationRun;
  stages: GenerationStage[];
  stageItems: GenerationStageItem[];
  resultArtifacts: GenerationRunResultArtifact[];
}

export interface GenerationRunResultArtifact {
  kind: GenerationStageItem["kind"];
  artifactId: string;
  assetId?: string;
  stageId: string;
  itemId?: string;
}

export interface CreateGenerationRunBody {
  briefVersionId?: string;
  prompt?: string;
  reviewGates?: unknown;
  assetReview?: unknown;
}

export interface CreateRunArgs {
  store: GenerationRunsStore;
  projectId: string;
  body: CreateGenerationRunBody;
}

type StageSeed = {
  type: GenerationStageType;
};

const STAGE_SEEDS: StageSeed[] = [
  { type: "brief_intake" },
  { type: "creative_plan" },
  { type: "asset_generation" },
  { type: "audio_generation" },
  { type: "timeline_assembly" },
  { type: "quality_review" },
  { type: "export" },
  { type: "ready" },
];

const GATEABLE_STAGE_SET = new Set<GenerationStageType>(
  GATEABLE_GENERATION_STAGE_TYPES
);
export function isGateableGenerationStageType(
  value: unknown
): value is GateableGenerationStageType {
  return typeof value === "string" && GATEABLE_STAGE_SET.has(value as GenerationStageType);
}

function parseReviewGates(body: CreateGenerationRunBody): GateableGenerationStageType[] {
  if (body.reviewGates === undefined || body.reviewGates === null) return [];
  if (!Array.isArray(body.reviewGates)) {
    throw new ApiError("validation_failed", "reviewGates must be an array.", {
      fields: [{ path: "reviewGates", message: "Must be an array of stage types." }],
    });
  }

  const gates: GateableGenerationStageType[] = [];
  const seen = new Set<GateableGenerationStageType>();
  body.reviewGates.forEach((raw, index) => {
    if (!isGateableGenerationStageType(raw)) {
      throw new ApiError("validation_failed", "reviewGates contains an invalid stage type.", {
        fields: [
          {
            path: `reviewGates.${index}`,
            message: "Must be a gateable generation stage type.",
          },
        ],
      });
    }
    if (!seen.has(raw)) {
      seen.add(raw);
      gates.push(raw);
    }
  });
  return gates;
}

function shouldGateTimelineForAssetReview(body: CreateGenerationRunBody): boolean {
  if (body.assetReview === undefined || body.assetReview === null) return false;
  if (typeof body.assetReview !== "object" || Array.isArray(body.assetReview)) {
    throw new ApiError("validation_failed", "assetReview must be an object.", {
      fields: [{ path: "assetReview", message: "Must be an object." }],
    });
  }

  const review = body.assetReview as {
    lowConfidenceAssetIds?: unknown;
    requireTimelineReview?: unknown;
  };
  if (
    review.lowConfidenceAssetIds !== undefined &&
    (!Array.isArray(review.lowConfidenceAssetIds) ||
      review.lowConfidenceAssetIds.some((id) => typeof id !== "string" || id.trim() === ""))
  ) {
    throw new ApiError("validation_failed", "assetReview.lowConfidenceAssetIds is invalid.", {
      fields: [
        {
          path: "assetReview.lowConfidenceAssetIds",
          message: "Must be an array of non-empty asset IDs.",
        },
      ],
    });
  }
  if (
    review.requireTimelineReview !== undefined &&
    typeof review.requireTimelineReview !== "boolean"
  ) {
    throw new ApiError("validation_failed", "assetReview.requireTimelineReview is invalid.", {
      fields: [
        {
          path: "assetReview.requireTimelineReview",
          message: "Must be a boolean.",
        },
      ],
    });
  }

  return (
    review.requireTimelineReview === true ||
    ((review.lowConfidenceAssetIds as string[] | undefined)?.length ?? 0) > 0
  );
}

export async function createRunWithSeedStages(args: CreateRunArgs): Promise<GenerationRunPayload> {
  const { store, projectId, body } = args;
  const parsedBody = body && typeof body === "object" && !Array.isArray(body)
    ? body
    : {};
  const briefVersionId = parsedBody.briefVersionId
    ? String(parsedBody.briefVersionId).trim() || undefined
    : undefined;
  const reviewGates = parseReviewGates(parsedBody);
  if (shouldGateTimelineForAssetReview(parsedBody) && !reviewGates.includes("timeline_assembly")) {
    reviewGates.push("timeline_assembly");
  }
  const reviewGateSet = new Set<GenerationStageType>(reviewGates);

  const run = await store.createRun({
    projectId,
    status: "queued" as GenerationRunStatus,
    ...(briefVersionId ? { briefVersionId } : {}),
    ...(reviewGates.length > 0 ? { reviewGates } : {}),
    reviewGate: null,
    currentStageType: "brief_intake",
    progressPercent: 0,
    message: "Run queued.",
  });

  const stages: GenerationStage[] = [];
  for (let i = 0; i < STAGE_SEEDS.length; i += 1) {
    const seed = STAGE_SEEDS[i];
    const stage = await store.saveStage({
      runId: run.runId,
      type: seed.type,
      label: GENERATION_STAGE_LABELS[seed.type],
      order: i,
      status: "queued",
      ...(reviewGateSet.has(seed.type) ? { isReviewGate: true } : {}),
      jobIds: [],
      artifactIds: [],
    });
    stages.push(stage);
  }

  return { run, stages, stageItems: [], resultArtifacts: [] };
}

export async function approveReviewGate(
  store: GenerationRunsStore,
  runId: string
): Promise<GenerationRunPayload> {
  const payload = requireExistingPayload(await assemblePayload(store, runId), runId);
  const { run, stages } = payload;
  if (isTerminalRunStatus(run.status)) {
    throw new ApiError("job_not_cancelable", "Terminal generation runs cannot be approved.", {
      status: run.status,
    });
  }
  if (!run.reviewGate) {
    return payload;
  }

  const gate = run.reviewGate;
  const stage = stages.find((s) => s.stageId === gate.stageId);
  if (!stage || stage.type !== gate.stageType) {
    throw new ApiError("validation_failed", "The current review gate no longer matches a stage.");
  }

  const reviewedAt = new Date().toISOString();
  await store.updateStage(stage.stageId, { reviewedAt });

  const nextStage = stages.find((s) => s.order > stage.order && s.status === "queued");
  await store.updateRun(run.runId, {
    reviewGate: null,
    currentStageType: nextStage?.type ?? run.currentStageType,
    message: nextStage
      ? `Approved ${stage.label}; continuing to ${nextStage.label}.`
      : `Approved ${stage.label}.`,
  });

  return requireExistingPayload(await assemblePayload(store, runId), runId);
}

export async function pauseAfterStageIfReviewGate(
  store: GenerationRunsStore,
  runId: string,
  stageId: string
): Promise<GenerationRunPayload> {
  const payload = requireExistingPayload(await assemblePayload(store, runId), runId);
  const { run, stages } = payload;
  const stage = stages.find((s) => s.stageId === stageId);
  if (!stage || !stage.isReviewGate || stage.status !== "succeeded") {
    return payload;
  }
  if (isTerminalRunStatus(run.status)) {
    return payload;
  }
  await store.updateRun(run.runId, {
    status: "running",
    currentStageType: stage.type,
    reviewGate: {
      stageType: stage.type as GateableGenerationStageType,
      stageId: stage.stageId,
      state: "awaiting_review",
      enteredAt: new Date().toISOString(),
    },
    message: `${stage.label} is ready for review.`,
  });
  return requireExistingPayload(await assemblePayload(store, runId), runId);
}

export async function rejectReviewGate(
  store: GenerationRunsStore,
  runId: string,
  body: unknown
): Promise<GenerationRunPayload> {
  const payload = requireExistingPayload(await assemblePayload(store, runId), runId);
  const { run, stages } = payload;
  if (isTerminalRunStatus(run.status)) {
    throw new ApiError("job_not_cancelable", "Terminal generation runs cannot be rejected.", {
      status: run.status,
    });
  }
  if (!run.reviewGate) {
    throw new ApiError("validation_failed", "Run is not awaiting review.");
  }

  const parsed = body && typeof body === "object" && !Array.isArray(body)
    ? (body as { stageType?: unknown; note?: unknown })
    : {};
  const gate = run.reviewGate;
  if (parsed.stageType !== undefined && parsed.stageType !== gate.stageType) {
    throw new ApiError("validation_failed", "Reject stageType must match the active review gate.", {
      fields: [{ path: "stageType", message: `Expected ${gate.stageType}.` }],
    });
  }

  const stage = stages.find((s) => s.stageId === gate.stageId);
  if (!stage || stage.type !== gate.stageType) {
    throw new ApiError("validation_failed", "The current review gate no longer matches a stage.");
  }
  const note = typeof parsed.note === "string" ? parsed.note.trim() : "";

  // Force the stage back through generation instead of re-presenting rejected
  // output. The run re-enters awaiting_review only after the stage succeeds.
  const items = await store.listStageItemsForStage(stage.stageId);
  await Promise.all(
    items.map((item) =>
      store.updateStageItem(item.itemId, {
        status: "queued",
        progressPercent: 0,
        assetId: undefined,
        artifactId: undefined,
        error: undefined,
      })
    )
  );

  await store.updateStage(stage.stageId, {
    status: "queued",
    progressPercent: 0,
    artifactIds: [],
    reviewedAt: undefined,
    startedAt: undefined,
    completedAt: undefined,
    error: undefined,
    message: note
      ? `Regenerating after feedback: ${note}`
      : "Regenerating after review feedback.",
  });
  await store.updateRun(run.runId, {
    status: "running",
    currentStageType: stage.type,
    reviewGate: null,
    message: note
      ? `Regenerating ${stage.label} after feedback: ${note}`
      : `Regenerating ${stage.label} after review feedback.`,
  });

  return requireExistingPayload(await assemblePayload(store, runId), runId);
}

export async function cancelGenerationRun(
  store: GenerationRunsStore,
  runId: string
): Promise<GenerationRunPayload> {
  const payload = requireExistingPayload(await assemblePayload(store, runId), runId);
  const { run, stages } = payload;
  if (isTerminalRunStatus(run.status)) {
    throw new ApiError("job_not_cancelable", "Run already finished.", {
      code: "job_not_cancelable",
      message: "Run already finished.",
      retryable: false,
    });
  }

  const canceledAt = new Date().toISOString();
  await store.updateRun(run.runId, {
    status: "canceled",
    reviewGate: null,
    completedAt: canceledAt,
    message: "Generation run canceled.",
  });
  await Promise.all(
    stages
      .filter((stage) => stage.status === "queued" || stage.status === "running")
      .map((stage) =>
        store.updateStage(stage.stageId, {
          status: "canceled",
          completedAt: canceledAt,
          message: "Canceled before this stage completed.",
        })
      )
  );

  return requireExistingPayload(await assemblePayload(store, runId), runId);
}

function isTerminalRunStatus(status: GenerationRunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

function requireExistingPayload(
  payload: GenerationRunPayload | null,
  runId: string
): GenerationRunPayload {
  if (!payload) throw new ApiError("not_found", `Generation run not found: ${runId}`);
  return payload;
}

export async function assemblePayload(
  store: GenerationRunsStore,
  runId: string
): Promise<GenerationRunPayload | null> {
  const run = await store.getRun(runId);
  if (!run) return null;
  const stages = await store.listStagesForRun(runId);

  const stageItems: GenerationStageItem[] = [];
  for (const stage of stages) {
    const items = await store.listStageItemsForStage(stage.stageId);
    stageItems.push(...items);
  }

  return {
    run: surfaceRunReviewGateState(run),
    stages: stages.map(surfaceStageReviewGateState),
    stageItems,
    resultArtifacts: collectResultArtifacts(stages, stageItems),
  };
}

function surfaceRunReviewGateState(run: GenerationRun): GenerationRun {
  return {
    ...run,
    reviewGates: run.reviewGates ?? [],
    reviewGate: run.reviewGate ?? null,
  };
}

function surfaceStageReviewGateState(stage: GenerationStage): GenerationStage {
  return {
    ...stage,
    isReviewGate: stage.isReviewGate ?? false,
    reviewedAt: stage.reviewedAt ?? null,
  };
}

function collectResultArtifacts(
  stages: GenerationStage[],
  stageItems: GenerationStageItem[]
): GenerationRunResultArtifact[] {
  const artifacts: GenerationRunResultArtifact[] = [];
  for (const stage of stages) {
    for (const artifactId of stage.artifactIds) {
      const matchingItem = stageItems.find(
        (i) => i.stageId === stage.stageId && i.artifactId === artifactId
      );
      artifacts.push({
        kind: matchingItem?.kind ?? "export",
        artifactId,
        stageId: stage.stageId,
        ...(matchingItem?.itemId ? { itemId: matchingItem.itemId } : {}),
        ...(matchingItem?.assetId ? { assetId: matchingItem.assetId } : {}),
      });
    }
  }
  return artifacts;
}

export function requireRun(
  payload: GenerationRunPayload | null,
  runId: string,
  projectId: string
): GenerationRunPayload {
  if (!payload || payload.run.projectId !== projectId) {
    throw new ApiError("not_found", `Generation run not found: ${runId}`);
  }
  return payload;
}

export async function approveGenerationRunGate(args: {
  store: GenerationRunsStore;
  runId: string;
  projectId: string;
}): Promise<GenerationRunPayload> {
  const { store, runId, projectId } = args;
  const payload = requireRun(await assemblePayload(store, runId), runId, projectId);
  const { run, stages } = payload;

  if (TERMINAL_RUN_STATUSES.has(run.status)) {
    throw new ApiError(
      "job_not_cancelable",
      `Generation run ${runId} is ${run.status} and cannot be approved.`,
      { status: run.status }
    );
  }

  if (!run.reviewGate) {
    if (ACTIVE_RUN_STATUSES.has(run.status)) return payload;
    throw new ApiError(
      "job_not_cancelable",
      `Generation run ${runId} is ${run.status} and cannot be approved.`,
      { status: run.status }
    );
  }

  const gatedStage = stages.find((stage) => stage.stageId === run.reviewGate?.stageId);
  if (!gatedStage) {
    throw new ApiError(
      "validation_failed",
      `Review gate points at a missing stage: ${run.reviewGate.stageId}`
    );
  }

  const reviewedAt = new Date().toISOString();
  const reviewedStage = await store.updateStage(gatedStage.stageId, {
    reviewedAt,
    status: "succeeded",
    progressPercent: 100,
    completedAt: gatedStage.completedAt ?? reviewedAt,
  });
  const updatedRun = await store.updateRun(runId, {
    reviewGate: null,
    status: "running",
    message: `${reviewedStage.label} approved.`,
  });
  await startNextStageAfter(store, updatedRun, reviewedStage);

  const nextPayload = await assemblePayload(store, runId);
  if (!nextPayload) throw new ApiError("not_found", `Generation run not found: ${runId}`);
  return nextPayload;
}

async function startNextStageAfter(
  store: GenerationRunsStore,
  run: GenerationRun,
  completedStage: GenerationStage
): Promise<void> {
  const stages = await store.listStagesForRun(run.runId);
  const nextStage = stages.find((stage) => stage.order > completedStage.order);
  if (!nextStage) {
    await store.updateRun(run.runId, {
      status: "succeeded",
      currentStageType: "ready",
      progressPercent: 100,
      message: "Your video is ready.",
      completedAt: new Date().toISOString(),
      reviewGate: null,
    });
    return;
  }

  const now = new Date().toISOString();
  await store.updateStage(nextStage.stageId, {
    status: "running",
    startedAt: nextStage.startedAt ?? now,
    progressPercent: nextStage.progressPercent ?? 0,
  });
  await store.updateRun(run.runId, {
    status: "running",
    currentStageType: nextStage.type,
    progressPercent: Math.round((nextStage.order / STAGE_SEEDS.length) * 100),
    message: `Running ${nextStage.label}.`,
    reviewGate: null,
    startedAt: run.startedAt ?? now,
  });
}
