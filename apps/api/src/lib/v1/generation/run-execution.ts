import {
  createEvaluatorRegistry,
  type EvaluatorRegistry,
} from "@popcorn/eval";
import { createInlineEvalEmitter } from "../../eval/inline-hook";
import {
  createSupabaseJudgmentStore,
  type JudgmentStore,
} from "../../eval/judgment-store";
import type { RunProgressEmitter } from "../generation-progress";
import { createRunWithSeedStages } from "../generation-runs/payload";
import { createPersistedRunProgressEmitter } from "../generation-runs/progress-emitter";
import {
  getGenerationRunStore,
} from "../generation-runs/store";
import type { GenerationRunsStore } from "../generation-runs/store";
import type { RunExecutionOptions } from "../generation";
import type { GenerationStageType } from "@popcorn/shared/v1/types";

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

export async function createGenerationRunExecution(
  args: CreateGenerationRunExecutionArgs
): Promise<GenerationRunExecution> {
  const runStore = args.runStore ?? getGenerationRunStore();
  const payload = await createRunWithSeedStages({
    store: runStore,
    projectId: args.projectId,
    body: bodyWithBriefVersion(args.body, args.briefVersionId),
  });
  const runId = payload.run.runId;
  const persistedProgress = createPersistedRunProgressEmitter(runStore, runId);
  const progress = createInlineEvalEmitter(persistedProgress, {
    registry: args.registry ?? createEvaluatorRegistry(),
    judgmentStore: args.judgmentStore ?? createSupabaseJudgmentStore(),
    runsStore: runStore,
    runId,
    deriveIntent: async (target) => ({
      stageType: target.stageType,
      modality: target.modality,
      briefVersionId: payload.run.briefVersionId,
    }),
  });

  return {
    runId,
    progress,
    execution: {
      async persistStageArtifact(input) {
        const stageId = await requireStageId(runStore, runId, input.stageType);
        const artifact = await runStore.saveStageArtifact({
          runId,
          stageId,
          kind: input.kind,
          content: input.content,
        });
        return { artifactId: artifact.artifactId };
      },
    },
  };
}
