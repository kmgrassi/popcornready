import assert from "node:assert/strict";
import test from "node:test";

import { createEvaluatorContext } from "./context";

test("createEvaluatorContext rejects generator-private context", () => {
  assert.throws(
    () =>
      createEvaluatorContext({
        stageType: "creative_plan",
        modality: "plan",
        artifact: { beats: [] },
        intent: { goal: "A short product story" },
        stageId: "stage-1",
        trigger: "auto",
        generatorPrompt: "hidden generator prompt",
      }),
    /generator-private field: generatorPrompt/
  );
});

test("createEvaluatorContext returns only judge-safe context fields", () => {
  assert.deepEqual(
    createEvaluatorContext({
      stageType: "creative_plan",
      modality: "plan",
      artifact: { beats: [] },
      intent: { goal: "A short product story" },
      stageId: "stage-1",
      artifactId: "artifact-1",
      trigger: "manual",
    }),
    {
      stageType: "creative_plan",
      tool: undefined,
      modality: "plan",
      artifact: { beats: [] },
      intent: { goal: "A short product story" },
      expectations: undefined,
      evidenceRef: undefined,
      caseId: undefined,
      stageId: "stage-1",
      itemId: undefined,
      artifactId: "artifact-1",
      assetId: undefined,
      trigger: "manual",
    }
  );
});
