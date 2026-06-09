import {
  GateableGenerationStageType,
  GenerationRun,
  GenerationStage,
  GenerationStageType,
} from "@popcorn/shared/v1/types";
import {
  BeginStageOptions,
  RunProgressEmitter,
  RunStageHandle,
  RunStageItemHandle,
  StageItemSucceedOptions,
  StageSucceedOptions,
  StageUpdate,
  StartStageItemOptions,
} from "../generation-progress";
import { isGateableGenerationStageType } from "./payload";
import { GenerationRunsStore } from "./store";

export class RunReviewGatePaused extends Error {
  readonly runId: string;
  readonly stageId: string;
  readonly stageType: GateableGenerationStageType;

  constructor(args: {
    runId: string;
    stageId: string;
    stageType: GateableGenerationStageType;
  }) {
    super(`Generation run ${args.runId} paused for review after ${args.stageType}.`);
    this.name = "RunReviewGatePaused";
    this.runId = args.runId;
    this.stageId = args.stageId;
    this.stageType = args.stageType;
  }
}

export function isRunReviewGatePaused(err: unknown): err is RunReviewGatePaused {
  return err instanceof RunReviewGatePaused;
}

export function createPersistedRunProgressEmitter(
  store: GenerationRunsStore,
  runId: string
): RunProgressEmitter {
  async function getRunOrThrow(): Promise<GenerationRun> {
    const run = await store.getRun(runId);
    if (!run) throw new Error(`generation run not found: ${runId}`);
    return run;
  }

  async function getStageByType(type: GenerationStageType): Promise<GenerationStage> {
    const stages = await store.listStagesForRun(runId);
    const stage = stages.find((s) => s.type === type);
    if (!stage) {
      throw new Error(`generation stage not found for ${type} on run ${runId}`);
    }
    return stage;
  }

  function stageHandle(stageId: string, type: GenerationStageType): RunStageHandle {
    async function getStage(): Promise<GenerationStage> {
      const stage = await store.getStage(stageId);
      if (!stage) throw new Error(`generation stage not found: ${stageId}`);
      return stage;
    }

    async function updateRunSummary(patch: StageUpdate): Promise<void> {
      await store.updateRun(runId, {
        status: "running",
        currentStageType: type,
        ...patch,
      });
    }

    return {
      type,

      async update(patch) {
        await store.updateStage(stageId, patch);
        await updateRunSummary(patch);
      },

      async startItem(opts: StartStageItemOptions): Promise<RunStageItemHandle> {
        const item = await store.saveStageItem({
          stageId,
          kind: opts.kind,
          label: opts.label,
          status: "running",
          progressPercent: 0,
          ...(opts.provider ? { provider: opts.provider } : {}),
          ...(opts.promptPreview ? { promptPreview: opts.promptPreview } : {}),
        });

        return {
          itemId: item.itemId,
          async update(patch) {
            await store.updateStageItem(item.itemId, patch);
          },
          async succeed(opts?: StageItemSucceedOptions) {
            await store.updateStageItem(item.itemId, {
              status: "succeeded",
              progressPercent: 100,
              ...(opts?.assetId ? { assetId: opts.assetId } : {}),
              ...(opts?.artifactId ? { artifactId: opts.artifactId } : {}),
              ...(opts?.message ? { message: opts.message } : {}),
            });
          },
          async fail(error) {
            await store.updateStageItem(item.itemId, {
              status: "failed",
              error,
            });
          },
        };
      },

      async attachJob(jobId) {
        const stage = await getStage();
        await store.updateStage(stageId, {
          jobIds: stage.jobIds.includes(jobId)
            ? stage.jobIds
            : [...stage.jobIds, jobId],
        });
      },

      async attachArtifact(artifactId) {
        const stage = await getStage();
        await store.updateStage(stageId, {
          artifactIds: stage.artifactIds.includes(artifactId)
            ? stage.artifactIds
            : [...stage.artifactIds, artifactId],
        });
      },

      async succeed(opts?: StageSucceedOptions) {
        const now = new Date().toISOString();
        // Link the stage's result artifact onto the stage before completing it,
        // so the evidence-bearing output is referenced from the run graph.
        if (opts?.resultArtifactId) {
          const stage = await getStage();
          if (!stage.artifactIds.includes(opts.resultArtifactId)) {
            await store.updateStage(stageId, {
              artifactIds: [...stage.artifactIds, opts.resultArtifactId],
            });
          }
        }
        const completed = await store.updateStage(stageId, {
          status: "succeeded",
          progressPercent: 100,
          completedAt: now,
          ...(opts?.message ? { message: opts.message } : {}),
        });

        if (
          completed.isReviewGate &&
          !completed.reviewedAt &&
          isGateableGenerationStageType(completed.type)
        ) {
          await store.updateRun(runId, {
            status: "running",
            currentStageType: completed.type,
            reviewGate: {
              stageType: completed.type,
              stageId: completed.stageId,
              state: "awaiting_review",
              enteredAt: now,
            },
            progressPercent: completed.progressPercent,
            message: opts?.message ?? `${completed.label} is ready for review.`,
          });
          throw new RunReviewGatePaused({
            runId,
            stageId: completed.stageId,
            stageType: completed.type,
          });
        }

        await store.updateRun(runId, {
          status: "running",
          currentStageType: completed.type,
          progressPercent: completed.progressPercent,
          message: opts?.message ?? completed.message,
        });
      },

      async fail(error) {
        const now = new Date().toISOString();
        await store.updateStage(stageId, {
          status: "failed",
          completedAt: now,
          error,
        });
        await store.updateRun(runId, {
          status: "failed",
          currentStageType: type,
          completedAt: now,
          error,
        });
      },

      async cancel(opts) {
        const now = new Date().toISOString();
        await store.updateStage(stageId, {
          status: "canceled",
          completedAt: now,
          ...(opts?.message ? { message: opts.message } : {}),
        });
        await store.updateRun(runId, {
          status: "canceled",
          currentStageType: type,
          completedAt: now,
          reviewGate: null,
          ...(opts?.message ? { message: opts.message } : {}),
        });
      },
    };
  }

  return {
    async beginStage(type: GenerationStageType, opts?: BeginStageOptions) {
      const run = await getRunOrThrow();
      const stage = await getStageByType(type);
      const now = new Date().toISOString();
      await store.updateRun(runId, {
        status: "running",
        currentStageType: type,
        ...(run.startedAt ? {} : { startedAt: now }),
        ...(opts?.message ? { message: opts.message } : {}),
      });
      const updated = await store.updateStage(stage.stageId, {
        status: "running",
        ...(stage.startedAt ? {} : { startedAt: now }),
        ...(opts?.label ? { label: opts.label } : {}),
        ...(opts?.message ? { message: opts.message } : {}),
        ...(typeof opts?.order === "number" ? { order: opts.order } : {}),
      });
      return stageHandle(updated.stageId, updated.type);
    },

    async updateRun(patch: StageUpdate) {
      await store.updateRun(runId, patch);
    },

    async getReviewFeedback() {
      const run = await getRunOrThrow();
      const feedback = run.reviewFeedback?.trim() ?? "";
      return feedback.length > 0 ? feedback : null;
    },

    async clearReviewFeedback() {
      await store.updateRun(runId, { reviewFeedback: null });
    },
  };
}
