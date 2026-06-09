import { ApiError } from "../errors";
import { runGenerationJob, type GenerationDeps } from "../generation";
import { getGenerationRunStore, type GenerationRunsStore } from "../generation-runs/store";
import { createExistingGenerationRunExecution } from "./run-execution";
import { getStore, type V1Store } from "../store";
import type { EvaluatorRegistry } from "@popcorn/eval";
import type { JudgmentStore } from "../../eval/judgment-store";

export interface ResumeGenerationRunArgs {
  runId: string;
  jobStore?: V1Store;
  runStore?: GenerationRunsStore;
  deps?: GenerationDeps;
  registry?: EvaluatorRegistry;
  judgmentStore?: JudgmentStore;
}

export async function resumeGenerationRun(
  args: ResumeGenerationRunArgs
) {
  const runStore = args.runStore ?? getGenerationRunStore();
  const jobStore = args.jobStore ?? getStore();
  const stages = await runStore.listStagesForRun(args.runId);
  const jobId = [...stages]
    .sort((a, b) => b.order - a.order)
    .flatMap((stage) => [...stage.jobIds].reverse())[0];

  if (!jobId) {
    throw new ApiError(
      "validation_failed",
      `Generation run ${args.runId} is not attached to a generation job.`
    );
  }

  const execution = await createExistingGenerationRunExecution({
    runId: args.runId,
    runStore,
    registry: args.registry,
    judgmentStore: args.judgmentStore,
  });
  return runGenerationJob(
    jobStore,
    jobId,
    args.deps,
    execution.progress,
    execution.execution
  );
}
