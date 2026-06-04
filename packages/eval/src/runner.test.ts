import assert from "node:assert/strict";
import test from "node:test";

import { EvaluatorRegistry } from "./registry";
import { runEvalSuite } from "./runner";
import type { EvalSuiteFixture, Evaluator } from "./types";

const planEvaluator: Evaluator = {
  id: "story_arc.v1",
  stageType: "creative_plan",
  modality: "plan",
  rubricVersion: "2026-06-04",
  judgeModel: "test-judge",
  schema: {},
  evidenceNeeded: ["artifact_json"],
  style: "reference_free",
  mode: "blocking_gate",
  thresholds: {
    storyArc: 7,
    promptReadiness: 7,
  },
  async run(ctx) {
    const artifact = ctx.artifact as { storyArc: number; promptReadiness: number };
    return {
      grades: {
        storyArc: artifact.storyArc,
        promptReadiness: artifact.promptReadiness,
      },
      rationale: "Fixture scorer",
      costUsd: 0.01,
      latencyMs: 12,
    };
  },
};

test("runEvalSuite emits append-only judgments and aggregates verdicts", async () => {
  const registry = new EvaluatorRegistry();
  registry.register(planEvaluator);
  const fixture: EvalSuiteFixture = {
    suite: { id: "suite-1", name: "Plan smoke" },
    cases: [
      {
        id: "case-pass",
        suiteId: "suite-1",
        label: "Good plan",
        stimulus: {
          kind: "brief",
          goal: "Make a launch video",
          targetLengthSec: 30,
          style: "documentary",
          aspectRatio: "16:9",
        },
        stagesToRun: ["creative_plan"],
        expectations: [
          {
            stageType: "creative_plan",
            gradeFloors: { storyArc: 7 },
          },
        ],
        artifacts: [
          {
            stageType: "creative_plan",
            artifactId: "artifact-plan-pass",
            artifact: { storyArc: 8, promptReadiness: 9 },
            intent: { goal: "Make a launch video" },
          },
        ],
      },
      {
        id: "case-fail",
        suiteId: "suite-1",
        label: "Bad plan",
        stimulus: {
          kind: "brief",
          goal: "Make a launch video",
          targetLengthSec: 30,
          style: "documentary",
          aspectRatio: "16:9",
        },
        stagesToRun: ["creative_plan"],
        artifacts: [
          {
            stageType: "creative_plan",
            artifactId: "artifact-plan-fail",
            artifact: { storyArc: 4, promptReadiness: 8 },
            intent: { goal: "Make a launch video" },
          },
        ],
      },
    ],
  };

  let counter = 0;
  const result = await runEvalSuite({
    registry,
    fixture,
    evalRunId: "eval-run-1",
    gitSha: "abc123",
    branch: "codex/test",
    now: () => new Date("2026-06-04T12:00:00.000Z"),
    id: () => `id-${(counter += 1)}`,
  });

  assert.equal(result.evalRun.status, "succeeded");
  assert.equal(result.evalRun.suiteId, "suite-1");
  assert.deepEqual(result.evalRun.judgeModels, { "story_arc.v1": "test-judge" });
  assert.equal(result.judgments.length, 2);
  assert.equal(result.judgments[0].verdict, "pass");
  assert.equal(result.judgments[1].verdict, "fail");
  assert.equal(result.judgments[0].trigger, "auto");
  assert.equal(result.judgments[0].evalRunId, "eval-run-1");
  assert.equal(result.judgments[0].caseId, "case-pass");
  assert.equal(result.judgments[0].artifactId, "artifact-plan-pass");
  assert.equal(result.evalRun.aggregate?.total, 2);
  assert.equal(result.evalRun.aggregate?.passRate, 0.5);
  assert.equal(result.evalRun.aggregate?.failRate, 0.5);
  assert.deepEqual(result.expectationResults, [
    {
      evalRunId: "eval-run-1",
      caseId: "case-pass",
      judgmentId: "id-1",
      matched: true,
    },
  ]);
});
