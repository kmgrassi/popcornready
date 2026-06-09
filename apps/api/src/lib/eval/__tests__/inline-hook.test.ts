import assert from "node:assert/strict";
import test from "node:test";

import { createEvaluatorRegistry, type Judgment } from "@popcorn/eval";

import { noopProgressEmitter, type RunProgressEmitter } from "../../v1/generation-progress";
import { createInlineEvalEmitter } from "../inline-hook";
import type { JudgmentStore } from "../judgment-store";
import type { GenerationRunsStore } from "../../v1/generation-runs/store";

test("inline eval emitter forwards review feedback helpers", async () => {
  let cleared = false;
  const inner: RunProgressEmitter = {
    ...noopProgressEmitter,
    async getReviewFeedback() {
      return "tighten the opening beat";
    },
    async clearReviewFeedback() {
      cleared = true;
    },
  };

  const wrapped = createInlineEvalEmitter(inner, {
    registry: createEvaluatorRegistry(),
    judgmentStore: {
      async saveJudgment(judgment: Judgment) {
        return judgment;
      },
      async listJudgmentsForRun() {
        return [];
      },
      async listJudgmentsForStage() {
        return [];
      },
    } satisfies JudgmentStore,
    runsStore: {
      async getStageArtifact() {
        return null;
      },
      async listStagesForRun() {
        return [];
      },
    } as unknown as GenerationRunsStore,
    runId: "run_feedback",
    deriveIntent: () => ({}),
  });

  assert.equal(await wrapped.getReviewFeedback?.(), "tighten the opening beat");
  await wrapped.clearReviewFeedback?.();
  assert.equal(cleared, true);
});
