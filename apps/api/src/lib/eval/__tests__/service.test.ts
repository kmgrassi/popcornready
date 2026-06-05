import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import {
  EvaluatorRegistry,
  type Evaluator,
  type EvaluatorContext,
  type JudgmentDraft,
} from "@popcorn/eval";

import { ApiError } from "@/core/errors";
import { createFileEvalStore, type EvalStore } from "../store";
import {
  diffRuns,
  getRunDetail,
  getSuiteDetail,
  judgeArtifact,
  listSuites,
  startSuiteRun,
} from "../service";

// Ids are DB-generated (uuid); the file store assigns them on insert.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let tmpDir: string;
let store: EvalStore;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "popcornready-eval-svc-"));
  store = createFileEvalStore(tmpDir);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// A deterministic evaluator whose grade (and thus verdict) is configurable, so a
// run/diff/on-demand judge produces predictable verdicts without any model call.
function stubEvaluator(grade: number, captured?: { ctx?: EvaluatorContext }): Evaluator {
  return {
    id: "story_arc.v1",
    stageType: "creative_plan",
    modality: "plan",
    rubricVersion: "v1",
    judgeModel: "test-judge",
    schema: {},
    evidenceNeeded: ["artifact_json"],
    style: "reference_free",
    mode: "blocking_gate",
    thresholds: { storyArc: 7 },
    async run(ctx: EvaluatorContext): Promise<JudgmentDraft> {
      if (captured) captured.ctx = ctx;
      return { grades: { storyArc: grade }, rationale: "stub" };
    },
  };
}

function registryWith(evaluator: Evaluator): EvaluatorRegistry {
  const registry = new EvaluatorRegistry();
  registry.register(evaluator);
  return registry;
}

async function seedSuiteWithCase(): Promise<{ suiteId: string; artifactId: string }> {
  const suite = await store.createSuite({ name: "Core" });
  await store.saveCase({
    suiteId: suite.id,
    label: "Launch arc",
    stimulus: {
      kind: "brief",
      goal: "launch doc",
      targetLengthSec: 60,
      style: "doc",
      aspectRatio: "16:9",
    },
    stagesToRun: ["creative_plan"],
    artifacts: [
      {
        stageType: "creative_plan",
        artifactId: "art_plan_1",
        artifact: { beats: ["hook", "turn", "payoff"] },
        intent: { goal: "launch doc" },
      },
    ],
  });
  return { suiteId: suite.id, artifactId: "art_plan_1" };
}

test("listSuites returns saved suites", async () => {
  await store.createSuite({ name: "Core" });
  const suites = await listSuites(store);
  assert.equal(suites.length, 1);
  assert.equal(suites[0].name, "Core");
});

test("getSuiteDetail returns the suite plus its cases", async () => {
  const { suiteId } = await seedSuiteWithCase();
  const detail = await getSuiteDetail(suiteId, store);
  assert.equal(detail.suite.id, suiteId);
  assert.equal(detail.cases.length, 1);
  assert.equal(detail.cases[0].label, "Launch arc");
});

test("getSuiteDetail throws not_found for an unknown suite", async () => {
  await assert.rejects(
    () => getSuiteDetail("evalsuite_missing", store),
    (err) => err instanceof ApiError && err.code === "not_found"
  );
});

test("startSuiteRun persists a run + judgments and returns the detail", async () => {
  const { suiteId } = await seedSuiteWithCase();
  const detail = await startSuiteRun({ suiteId }, store, registryWith(stubEvaluator(9)));

  assert.match(detail.run.id, UUID_RE);
  assert.equal(detail.run.status, "succeeded");
  assert.equal(detail.run.suiteId, suiteId);
  assert.equal(detail.judgments.length, 1);
  assert.equal(detail.judgments[0].verdict, "pass");
  assert.equal(detail.judgments[0].evaluatorId, "story_arc.v1");

  // Persisted: a fresh read sees the same run + judgments.
  const persisted = await getRunDetail(detail.run.id, store);
  assert.equal(persisted.run.id, detail.run.id);
  assert.equal(persisted.judgments.length, 1);
  assert.equal(persisted.cases.length, 1);
});

test("startSuiteRun throws not_found for an unknown suite", async () => {
  await assert.rejects(
    () => startSuiteRun({ suiteId: "evalsuite_missing" }, store, new EvaluatorRegistry()),
    (err) => err instanceof ApiError && err.code === "not_found"
  );
});

test("getRunDetail throws not_found for an unknown run", async () => {
  await assert.rejects(
    () => getRunDetail("evalrun_missing", store),
    (err) => err instanceof ApiError && err.code === "not_found"
  );
});

test("diffRuns reports verdict flips between two runs of the same suite", async () => {
  const { suiteId } = await seedSuiteWithCase();
  // First run passes (grade 9 >= floor+1), second fails (grade 2 < floor 7).
  const before = await startSuiteRun({ suiteId }, store, registryWith(stubEvaluator(9)));
  const after = await startSuiteRun({ suiteId }, store, registryWith(stubEvaluator(2)));

  const diff = await diffRuns(before.run.id, after.run.id, store);
  assert.equal(diff.flips.length, 1);
  assert.equal(diff.flips[0].before, "pass");
  assert.equal(diff.flips[0].after, "fail");
  assert.equal(diff.flips[0].evaluatorId, "story_arc.v1");
  assert.equal(diff.flips[0].artifactId, "art_plan_1");
});

test("diffRuns keeps same-stage item judgments distinct when artifactId is absent", async () => {
  const before = await store.saveRun({
    source: "suite",
    generationMode: "prompts_only",
    gitSha: "abc123",
    branch: "feat/eval-http-api",
    judgeModels: {},
    status: "succeeded",
    createdAt: "2026-06-04T10:00:00.000Z",
  });
  const after = await store.saveRun({
    source: "suite",
    generationMode: "prompts_only",
    gitSha: "abc124",
    branch: "feat/eval-http-api",
    judgeModels: {},
    status: "succeeded",
    createdAt: "2026-06-04T11:00:00.000Z",
  });

  for (const itemId of ["item_a", "item_b"]) {
    await store.saveJudgment({
      id: "",
      evaluatorId: "story_arc.v1",
      rubricVersion: "v1",
      judgeModel: "test-judge",
      evalRunId: before.id,
      caseId: "evalcase_1",
      stageId: "stage_shared",
      itemId,
      grades: { storyArc: 9 },
      verdict: "pass",
      rationale: "before",
      trigger: "auto",
      costUsd: 0,
      latencyMs: 1,
      createdAt: "2026-06-04T10:00:01.000Z",
    });
    await store.saveJudgment({
      id: "",
      evaluatorId: "story_arc.v1",
      rubricVersion: "v1",
      judgeModel: "test-judge",
      evalRunId: after.id,
      caseId: "evalcase_1",
      stageId: "stage_shared",
      itemId,
      grades: { storyArc: 2 },
      verdict: "fail",
      rationale: "after",
      trigger: "auto",
      costUsd: 0,
      latencyMs: 1,
      createdAt: "2026-06-04T11:00:01.000Z",
    });
  }

  const diff = await diffRuns(before.id, after.id, store);
  assert.deepEqual(
    diff.flips.map((flip) => flip.itemId).sort(),
    ["item_a", "item_b"]
  );
});

test("diffRuns throws not_found when a run is missing", async () => {
  const { suiteId } = await seedSuiteWithCase();
  const run = await startSuiteRun({ suiteId }, store, registryWith(stubEvaluator(9)));
  await assert.rejects(
    () => diffRuns(run.run.id, "evalrun_missing", store),
    (err) => err instanceof ApiError && err.code === "not_found"
  );
});

test("judgeArtifact runs one evaluator on demand and persists a manual Judgment", async () => {
  const { artifactId } = await seedSuiteWithCase();
  const captured: { ctx?: EvaluatorContext } = {};
  const judgment = await judgeArtifact(
    { evaluatorId: "story_arc.v1", artifactId },
    store,
    registryWith(stubEvaluator(7, captured))
  );

  assert.match(judgment.id, UUID_RE);
  assert.equal(judgment.trigger, "manual");
  assert.equal(judgment.verdict, "needs_review"); // grade 7 in [floor 7, floor+1)
  assert.equal(judgment.artifactId, artifactId);
  // Context isolation: the judge sees the artifact + intent, marked manual.
  assert.equal(captured.ctx?.trigger, "manual");
  assert.deepEqual(captured.ctx?.artifact, { beats: ["hook", "turn", "payoff"] });

  // Persisted (append-only): readable by id.
  const read = await store.getJudgment(judgment.id);
  assert.ok(read);
  assert.equal(read!.id, judgment.id);
});

test("judgeArtifact rejects an unknown evaluator with validation_failed", async () => {
  const { artifactId } = await seedSuiteWithCase();
  await assert.rejects(
    () => judgeArtifact({ evaluatorId: "nope.v9", artifactId }, store, new EvaluatorRegistry()),
    (err) => err instanceof ApiError && err.code === "validation_failed"
  );
});

test("judgeArtifact throws not_found for an unknown artifact", async () => {
  await seedSuiteWithCase();
  await assert.rejects(
    () =>
      judgeArtifact(
        { evaluatorId: "story_arc.v1", artifactId: "art_missing" },
        store,
        registryWith(stubEvaluator(8))
      ),
    (err) => err instanceof ApiError && err.code === "not_found"
  );
});
