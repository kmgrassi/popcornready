import {
  computeVerdict,
  createEvaluatorContext,
  shouldRunEvaluator,
  type EvalModality,
  type Evaluator,
  type EvaluatorContext,
  type EvaluatorRegistry,
  type Judgment,
  type SamplingPolicy,
} from "@popcorn/eval";
import {
  GateableGenerationStageType,
  GenerationJudgmentSummary,
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
} from "../v1/generation-progress";
import { isGateableGenerationStageType } from "../v1/generation-runs/payload";
import { RunReviewGatePaused } from "../v1/generation-runs/progress-emitter";
import { GenerationRunsStore } from "../v1/generation-runs/store";
import { newId } from "../v1/ids";
import { JudgmentStore } from "./judgment-store";

// Inline judging hook (Stage Eval Framework §3 "One hook point").
//
// Wraps a RunProgressEmitter so that on every `stage.succeed()` /
// `item.succeed()` — now carrying a persisted, addressable artifact — the
// registered evaluator(s) for that stage read the just-persisted artifact, fire,
// and write Judgments. Two modes (§9.1):
//   - blocking_gate evaluators run SYNCHRONOUSLY; a `fail` pauses the run
//     (reusing the reviewGates pause plumbing) before expensive downstream work.
//   - observational evaluators run without blocking and are sampled per §9.5
//     (text/structured = 100%; media = per-clip subset).
//
// The EvaluatorContext is built CONTEXT-ISOLATED: only the artifact + an
// independently-derived spec/intent, never the generator's prompt/context (§3
// "Context isolation"). The `deriveIntent` callback supplies that independent
// spec from run-level facts; it must not be threaded through from the generation
// call's prompt.

export interface JudgmentTargetMeta {
  stageType: GenerationStageType;
  tool?: string;
  modality: EvalModality;
  stageId: string;
  itemId?: string;
  artifactId?: string;
  assetId?: string;
}

export type DeriveIntent = (
  target: JudgmentTargetMeta
) => unknown | Promise<unknown>;

export interface InlineEvalConfig {
  registry: EvaluatorRegistry;
  judgmentStore: JudgmentStore;
  runsStore: GenerationRunsStore;
  runId: string;
  // Context-isolated spec deriver. MUST NOT receive the generator's prompt or
  // working context — only run/stage-level facts about what the output *should*
  // be (§3 Context isolation).
  deriveIntent: DeriveIntent;
  // Observational sampling policy (§9.5). Blocking gates always run at 100%.
  samplingPolicy?: SamplingPolicy;
  now?: () => Date;
  id?: () => string;
}

const MODALITY_BY_KIND: Record<string, EvalModality> = {
  image: "image",
  video: "video",
  audio: "audio",
  caption: "plan",
  timeline: "timeline",
  export: "video",
};

// Default modality for a stage's *stage-level* result artifact. Item-level
// modality is derived from the item kind instead.
const STAGE_MODALITY: Partial<Record<GenerationStageType, EvalModality>> = {
  creative_plan: "plan",
  timeline_assembly: "timeline",
  quality_review: "timeline",
  export: "video",
};

function summaryFromJudgment(judgment: Judgment): GenerationJudgmentSummary {
  const summary: GenerationJudgmentSummary = {
    judgmentId: judgment.id,
    evaluatorId: judgment.evaluatorId,
    verdict: judgment.verdict,
    rationale: judgment.rationale,
    createdAt: judgment.createdAt,
  };
  if (judgment.recommendedAction) summary.recommendedAction = judgment.recommendedAction;
  if (judgment.grades) summary.grades = judgment.grades;
  if (judgment.evidenceRef) summary.evidenceRef = judgment.evidenceRef;
  return summary;
}

export function createInlineEvalEmitter(
  inner: RunProgressEmitter,
  config: InlineEvalConfig
): RunProgressEmitter {
  const now = config.now ?? (() => new Date());
  const id = config.id ?? (() => newId("judg"));
  const samplingPolicy = config.samplingPolicy;

  // Run one evaluator against a target, persisting the Judgment. Returns the
  // Judgment so the caller can act on a blocking_gate `fail`.
  async function runOne(
    evaluator: Evaluator,
    target: JudgmentTargetMeta
  ): Promise<Judgment> {
    const artifact = target.artifactId
      ? await config.runsStore.getStageArtifact(target.artifactId)
      : null;

    const intent = await config.deriveIntent(target);

    // createEvaluatorContext throws if any generator-private field leaks in,
    // enforcing context isolation at the boundary.
    const context: EvaluatorContext = createEvaluatorContext({
      stageType: target.stageType,
      tool: target.tool,
      modality: target.modality,
      artifact: artifact ? artifact.content : null,
      intent,
      evidenceRef: target.artifactId,
      stageId: target.stageId,
      itemId: target.itemId,
      artifactId: target.artifactId,
      assetId: target.assetId,
      trigger: "auto",
    });

    const startedAt = Date.now();
    const draft = await evaluator.run(context);
    const latencyMs = draft.latencyMs ?? Date.now() - startedAt;
    const verdict = computeVerdict(draft.grades, evaluator.thresholds);

    const judgment: Judgment = {
      id: id(),
      evaluatorId: evaluator.id,
      rubricVersion: evaluator.rubricVersion,
      judgeModel: evaluator.judgeModel,
      generationRunId: config.runId,
      stageId: target.stageId,
      itemId: target.itemId,
      artifactId: target.artifactId,
      assetId: target.assetId,
      grades: draft.grades,
      verdict,
      rationale: draft.rationale,
      recommendedAction: draft.recommendedAction,
      evidenceRef: draft.evidenceRef ?? target.artifactId,
      trigger: "auto",
      costUsd: draft.costUsd ?? 0,
      latencyMs,
      createdAt: now().toISOString(),
    };
    await config.judgmentStore.saveJudgment(judgment);
    return judgment;
  }

  // Fire all registered evaluators for a target. Persists each Judgment and the
  // latest verdict summary onto the graph node. If a blocking_gate evaluator
  // fails, pauses the run (reviewGate plumbing) and throws RunReviewGatePaused
  // so the worker halts before expensive downstream work.
  async function judge(
    target: JudgmentTargetMeta,
    setSummary: (summary: GenerationJudgmentSummary) => Promise<void>
  ): Promise<void> {
    const evaluators = config.registry.forStage(target.stageType, target.tool);
    for (const evaluator of evaluators) {
      const runIt = shouldRunEvaluator({
        evaluator: { mode: evaluator.mode, modality: evaluator.modality },
        target: {
          itemId: target.itemId,
          artifactId: target.artifactId,
          assetId: target.assetId,
        },
        ...(samplingPolicy ? { policy: samplingPolicy } : {}),
      });
      if (!runIt) continue;

      const judgment = await runOne(evaluator, target);
      await setSummary(summaryFromJudgment(judgment));

      if (evaluator.mode === "blocking_gate" && judgment.verdict === "fail") {
        await pauseForFailedGate(target.stageType, target.stageId, judgment);
      }
    }
  }

  async function pauseForFailedGate(
    stageType: GenerationStageType,
    stageId: string,
    judgment: Judgment
  ): Promise<never> {
    if (!isGateableGenerationStageType(stageType)) {
      // Non-gateable blocking stage: cannot pause via the run review gate, so
      // surface as a hard run failure instead of silently passing.
      throw new Error(
        `Blocking evaluator ${judgment.evaluatorId} failed on non-gateable stage ${stageType}.`
      );
    }
    const gateType: GateableGenerationStageType = stageType;
    const enteredAt = now().toISOString();
    await config.runsStore.updateRun(config.runId, {
      status: "running",
      currentStageType: stageType,
      reviewGate: {
        stageType: gateType,
        stageId,
        state: "awaiting_review",
        enteredAt,
      },
      message: `Blocked by ${judgment.evaluatorId}: ${judgment.rationale}`,
    });
    throw new RunReviewGatePaused({ runId: config.runId, stageId, stageType: gateType });
  }

  function wrapStage(handle: RunStageHandle): RunStageHandle {
    let stageId: string | undefined;

    return {
      type: handle.type,
      update: (patch: StageUpdate) => handle.update(patch),
      attachJob: (jobId: string) => handle.attachJob(jobId),
      attachArtifact: (artifactId: string) => handle.attachArtifact(artifactId),
      fail: (error) => handle.fail(error),
      cancel: (opts) => handle.cancel(opts),

      async startItem(opts: StartStageItemOptions): Promise<RunStageItemHandle> {
        const item = await handle.startItem(opts);
        return wrapItem(item, handle.type, opts);
      },

      async succeed(opts?: StageSucceedOptions): Promise<void> {
        // Resolve the stageId by reading it back from the persisted run before
        // we complete it, so the Judgment can reference the graph node.
        stageId = await resolveStageId(handle.type);

        // Judge BEFORE completing the stage: a blocking_gate fail must pause the
        // run before any further downstream stage work runs. `judge` throws
        // RunReviewGatePaused on a fail, short-circuiting `handle.succeed`.
        if (opts?.resultArtifactId && stageId) {
          const modality = STAGE_MODALITY[handle.type] ?? "plan";
          await judge(
            {
              stageType: handle.type,
              modality,
              stageId,
              artifactId: opts.resultArtifactId,
            },
            async (summary) => {
              await config.runsStore.updateStage(stageId!, { judgment: summary });
            }
          );
        }

        await handle.succeed(opts);
      },
    };
  }

  function wrapItem(
    item: RunStageItemHandle,
    stageType: GenerationStageType,
    startOpts: StartStageItemOptions
  ): RunStageItemHandle {
    return {
      itemId: item.itemId,
      update: (patch: StageUpdate) => item.update(patch),
      fail: (error) => item.fail(error),

      async succeed(opts?: StageItemSucceedOptions): Promise<void> {
        await item.succeed(opts);

        // Item-level judging only fires when the item produced a persisted
        // artifact to evaluate.
        if (opts?.artifactId) {
          const stageId = await resolveStageIdForItem(item.itemId, stageType);
          if (stageId) {
            const modality = MODALITY_BY_KIND[startOpts.kind] ?? "video";
            await judge(
              {
                stageType,
                modality,
                stageId,
                itemId: item.itemId,
                artifactId: opts.artifactId,
                assetId: opts.assetId,
              },
              async (summary) => {
                await config.runsStore.updateStageItem(item.itemId, {
                  judgment: summary,
                });
              }
            );
          }
        }
      },
    };
  }

  async function resolveStageId(
    type: GenerationStageType
  ): Promise<string | undefined> {
    const stages = await config.runsStore.listStagesForRun(config.runId);
    return stages.find((s) => s.type === type)?.stageId;
  }

  async function resolveStageIdForItem(
    itemId: string,
    _type: GenerationStageType
  ): Promise<string | undefined> {
    const item = await config.runsStore.getStageItem(itemId);
    return item?.stageId;
  }

  return {
    async beginStage(
      type: GenerationStageType,
      opts?: BeginStageOptions
    ): Promise<RunStageHandle> {
      const handle = await inner.beginStage(type, opts);
      return wrapStage(handle);
    },
    updateRun: (patch: StageUpdate) => inner.updateRun(patch),
  };
}
