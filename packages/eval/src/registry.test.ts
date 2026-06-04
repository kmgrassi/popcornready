import assert from "node:assert/strict";
import test from "node:test";

import { createEvaluatorRegistry, EvaluatorRegistry } from "./registry";
import type { Evaluator } from "./types";

const baseEvaluator: Evaluator = {
  id: "plan.generic",
  stageType: "creative_plan",
  modality: "plan",
  rubricVersion: "2026-06-04",
  judgeModel: "test-judge",
  schema: {},
  evidenceNeeded: ["artifact_json"],
  style: "reference_free",
  mode: "blocking_gate",
  thresholds: {},
  async run() {
    return { grades: {}, rationale: "ok" };
  },
};

test("forStage includes generic evaluators and exact tool matches only", () => {
  const registry = new EvaluatorRegistry();
  registry.register(baseEvaluator);
  registry.register({
    ...baseEvaluator,
    id: "plan.outline",
    tool: "outline",
  });

  assert.deepEqual(
    registry.forStage("creative_plan").map((evaluator) => evaluator.id),
    ["plan.generic"]
  );
  assert.deepEqual(
    registry.forStage("creative_plan", "outline").map((evaluator) => evaluator.id),
    ["plan.generic", "plan.outline"]
  );
});

test("registry rejects duplicate evaluator ids", () => {
  const registry = createEvaluatorRegistry([baseEvaluator]);

  assert.throws(() => registry.register(baseEvaluator), /already registered/);
});

test("register rejects duplicate evaluator IDs across stages and tools", () => {
  const registry = new EvaluatorRegistry();
  registry.register(baseEvaluator);

  assert.throws(
    () =>
      registry.register({
        ...baseEvaluator,
        stageType: "quality_review",
      }),
    /Evaluator already registered: plan\.generic/
  );
});
