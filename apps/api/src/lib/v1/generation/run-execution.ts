import {
  createEvaluatorRegistry,
  type EvaluatorRegistry,
} from "@popcorn/eval";
import type {
  GateableGenerationStageType,
  GenerationJob,
  GenerationStage,
  GenerationStageType,
} from "@popcorn/shared/v1/types";

import { createInlineEvalEmitter } from "../../eval/inline-hook";
import {
  createSupabaseJudgmentStore,
  type JudgmentStore,
} from "../../eval/judgment-store";
import { ApiError } from "../errors";
import {
  runGenerationJob,
  type GenerationDeps,
  type RunExecutionOptions,
} from "../generation";
import type { RunProgressEmitter } from "../generation-progress";
import { createRunWithSeedStages } from "../generation-runs/payload";
import { createPersistedRunProgressEmitter } from "../generation-runs/progress-emitter";
import {
  getGenerationRunStore,
  type GenerationRunsStore,
} from "../generation-runs/store";
import { getStore, type V1Store } from "../store";

interface CreateGenerationRunExecutionArgs {
  projectId: string;
  briefVersionId?: string;
  body?: unknown;
  runStore?: GenerationRunsStore;
  registry?: EvaluatorRegistry;
  judgmentStore?: JudgmentStore;
}

interface GenerationRunExecution {
  runId: string;
  progress: RunProgressEmitter;
  execution: RunExecutionOptions;
}

interface BuildGenerationRunExecutionArgs {
  runId: string;
  briefVersionId?: string;
  runStore?: GenerationRunsStore;
  registry?: EvaluatorRegistry;
  judgmentStore?: JudgmentStore;
}

interface ResumeGenerationRunArgs {
  runId: string;
  projectId?: string;
  store?: V1Store;
  runStore?: GenerationRunsStore;
  deps?: GenerationDeps;
  registry?: EvaluatorRegistry;
  judgmentStore?: JudgmentStore;
}

function bodyWithBriefVersion(
  body: unknown,
  briefVersionId: string | undefined
): Record<string, unknown> {
  const source =
    typeof body === "object" && body !== null && !Array.isArray(body) ? body : {};
  return {
    ...(source as Record<string, unknown>),
    ...(briefVersionId ? { briefVersionId } : {}),
  };
}

async function requireStageId(
  store: GenerationRunsStore,
  runId: string,
  stageType: GenerationStageType
): Promise<string> {
  const stages = await store.listStagesForRun(runId);
  const stage = stages.find((candidate) => candidate.type === stageType);
  if (!stage) {
    throw new Error(`generation stage not found for ${stageType} on run ${runId}`);
  }
  return stage.stageId;
}

async function loadStageOutput(
  store: GenerationRunsStore,
  runId: string,
  stageType: GenerationStageType
): ReturnType<NonNullable<RunExecutionOptions["loadStageOutput"]>> {
  const stages = await store.listStagesForRun(runId);
  const stage = stages.find((candidate) => candidate.type === stageType);
  if (!stage) return null;
  if (stage.status !== "succeeded") return { status: stage.status };

  const artifactId = stage.artifactIds.at(-1);
  if (!artifactId) return { status: stage.status };

  const artifact = await store.getStageArtifact(artifactId);
  if (!artifact) {
    throw new Error(
      `generation stage artifact not found for ${stageType} on run ${runId}: ${artifactId}`
    );
  }
  return {
    status: stage.status,
    artifactId: artifact.artifactId,
    content: artifact.content,
  };
}

async function checkPendingReviewGate(
  store: GenerationRunsStore,
  runId: string
): ReturnType<NonNullable<RunExecutionOptions["checkPendingReviewGate"]>> {
  const run = await store.getRun(runId);
  const gate = run?.reviewGate;
  if (!gate || gate.state !== "awaiting_review") return null;
  return {
    runId,
    stageId: gate.stageId,
    stageType: gate.stageType as GateableGenerationStageType,
  };
}

async function buildGenerationRunExecution(
  args: BuildGenerationRunExecutionArgs
): Promise<GenerationRunExecution> {
  const runStore = args.runStore ?? getGenerationRunStore();
  const persistedProgress = createPersistedRunProgressEmitter(runStore, args.runId);
  const progress = createInlineEvalEmitter(persistedProgress, {
    registry: args.registry ?? createEvaluatorRegistry(),
    judgmentStore: args.judgmentStore ?? createSupabaseJudgmentStore(),
    runsStore: runStore,
    runId: args.runId,
    deriveIntent: async (target) => ({
      stageType: target.stageType,
      modality: target.modality,
      briefVersionId: args.briefVersionId,
    }),
  });

  return {
    runId: args.runId,
    progress,
    execution: {
      async persistStageArtifact(input) {
        const stageId = await requireStageId(runStore, args.runId, input.stageType);
        const artifact = await runStore.saveStageArtifact({
          runId: args.runId,
          stageId,
          kind: input.kind,
          content: input.content,
        });
        return { artifactId: artifact.artifactId };
      },
      loadStageOutput: (input) =>
        loadStageOutput(runStore, args.runId, input.stageType),
      checkPendingReviewGate: () => checkPendingReviewGate(runStore, args.runId),
    },
  };
}

export async function createGenerationRunExecution(
  args: CreateGenerationRunExecutionArgs
): Promise<GenerationRunExecution> {
  const runStore = args.runStore ?? getGenerationRunStore();
  const payload = await createRunWithSeedStages({
    store: runStore,
    projectId: args.projectId,
    body: bodyWithBriefVersion(args.body, args.briefVersionId),
  });
  return buildGenerationRunExecution({
    runId: payload.run.runId,
    briefVersionId: payload.run.briefVersionId,
    runStore,
    registry: args.registry,
    judgmentStore: args.judgmentStore,
  });
}

export async function createGenerationRunExecutionForRun(
  args: BuildGenerationRunExecutionArgs
): Promise<GenerationRunExecution> {
  return buildGenerationRunExecution(args);
}

function orderedAttachedJobIds(stages: GenerationStage[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const stage of [...stages].sort((a, b) => b.order - a.order)) {
    for (const jobId of [...stage.jobIds].reverse()) {
      if (!seen.has(jobId)) {
        seen.add(jobId);
        ids.push(jobId);
      }
    }
  }
  return ids;
}

async function loadAttachedGenerationJobs(
  store: V1Store,
  projectId: string,
  jobIds: string[]
): Promise<GenerationJob[]> {
  const jobs: GenerationJob[] = [];
  for (const jobId of jobIds) {
    const job = (await store.getJob(jobId)) as GenerationJob | null;
    if (job?.type === "generation" && job.projectId === projectId) {
      jobs.push(job);
    }
  }
  return jobs;
}

export async function resumeGenerationRun(
  args: ResumeGenerationRunArgs
): Promise<GenerationJob> {
  const runStore = args.runStore ?? getGenerationRunStore();
  const store = args.store ?? getStore();
  const run = await runStore.getRun(args.runId);
  if (!run) {
    throw new ApiError("not_found", `Generation run not found: ${args.runId}`);
  }
  if (args.projectId && run.projectId !== args.projectId) {
    throw new ApiError("not_found", `Generation run not found: ${args.runId}`);
  }

  const stages = await runStore.listStagesForRun(args.runId);
  const jobs = await loadAttachedGenerationJobs(
    store,
    run.projectId,
    orderedAttachedJobIds(stages)
  );
  const queued = jobs.find((job) => job.status === "queued");
  if (!queued) {
    const running = jobs.find((job) => job.status === "running");
    if (running) {
      throw new ApiError(
        "job_not_cancelable",
        "Generation run is already resuming.",
        { jobId: running.id }
      );
    }
    throw new ApiError(
      "validation_failed",
      "Generation run has no queued generation job to resume."
    );
  }

  const execution = await buildGenerationRunExecution({
    runId: args.runId,
    briefVersionId: run.briefVersionId,
    runStore,
    registry: args.registry,
    judgmentStore: args.judgmentStore,
  });
  return runGenerationJob(
    store,
    queued.id,
    args.deps,
    execution.progress,
    execution.execution
  );
}
