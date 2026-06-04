import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import type { EvalRun, Judgment } from "@popcorn/eval";

import { createFileEvalStore, type EvalStore } from "../store";

let tmpDir: string;
let store: EvalStore;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "popcornready-eval-store-"));
  store = createFileEvalStore(tmpDir);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeRun(overrides: Partial<EvalRun> = {}): EvalRun {
  return {
    id: "evalrun_1",
    source: "suite",
    suiteId: "evalsuite_1",
    generationMode: "prompts_only",
    gitSha: "abc1234",
    branch: "feat/eval-http-api",
    judgeModels: {},
    status: "succeeded",
    createdAt: "2026-06-04T10:00:00.000Z",
    ...overrides,
  };
}

function makeJudgment(overrides: Partial<Judgment> = {}): Judgment {
  return {
    id: "judgment_1",
    evaluatorId: "story_arc.v1",
    rubricVersion: "v1",
    judgeModel: "test-model",
    evalRunId: "evalrun_1",
    caseId: "evalcase_1",
    stageId: "evalcase_1:creative_plan",
    grades: { storyArc: 8 },
    verdict: "pass",
    rationale: "Clear arc.",
    trigger: "auto",
    costUsd: 0,
    latencyMs: 1,
    createdAt: "2026-06-04T10:00:01.000Z",
    ...overrides,
  };
}

test("createSuite assigns an id when omitted and round-trips", async () => {
  const suite = await store.createSuite({ name: "Long-form core", description: "desc" });
  assert.match(suite.id, /^evalsuite_/);
  const read = await store.getSuite(suite.id);
  assert.deepEqual(read, suite);
});

test("listSuites returns all saved suites", async () => {
  await store.createSuite({ id: "evalsuite_a", name: "A" });
  await store.createSuite({ id: "evalsuite_b", name: "B" });
  const suites = await store.listSuites();
  assert.equal(suites.length, 2);
});

test("getSuite returns null for an unknown id", async () => {
  assert.equal(await store.getSuite("evalsuite_missing"), null);
});

test("saveCase defaults artifacts and scopes by suite", async () => {
  const created = await store.saveCase({
    suiteId: "evalsuite_1",
    label: "Launch arc",
    stimulus: { kind: "brief", goal: "g", targetLengthSec: 60, style: "doc", aspectRatio: "16:9" },
    stagesToRun: ["creative_plan"],
  });
  assert.match(created.id, /^evalcase_/);
  assert.deepEqual(created.artifacts, []);

  await store.saveCase({
    suiteId: "evalsuite_other",
    label: "Other",
    stimulus: { kind: "brief", goal: "g", targetLengthSec: 60, style: "doc", aspectRatio: "16:9" },
    stagesToRun: ["creative_plan"],
  });

  const cases = await store.listCasesForSuite("evalsuite_1");
  assert.equal(cases.length, 1);
  assert.equal(cases[0].id, created.id);
});

test("saveRun + getRun + listRunsForSuite (newest first)", async () => {
  const older = await store.saveRun(makeRun({ id: "evalrun_old", createdAt: "2026-06-01T00:00:00.000Z" }));
  const newer = await store.saveRun(makeRun({ id: "evalrun_new", createdAt: "2026-06-04T00:00:00.000Z" }));

  assert.deepEqual(await store.getRun(older.id), older);
  const runs = await store.listRunsForSuite("evalsuite_1");
  assert.equal(runs.length, 2);
  assert.equal(runs[0].id, newer.id);
  assert.equal(runs[1].id, older.id);
});

test("getRun returns null for an unknown id", async () => {
  assert.equal(await store.getRun("evalrun_missing"), null);
});

test("judgments are append-only: a duplicate id is rejected", async () => {
  const judgment = makeJudgment();
  await store.saveJudgment(judgment);
  await assert.rejects(() => store.saveJudgment(judgment), /append-only/);
});

test("listJudgmentsForRun scopes by run and orders oldest-first", async () => {
  await store.saveJudgment(makeJudgment({ id: "judgment_2", createdAt: "2026-06-04T10:00:02.000Z" }));
  await store.saveJudgment(makeJudgment({ id: "judgment_1", createdAt: "2026-06-04T10:00:01.000Z" }));
  await store.saveJudgment(makeJudgment({ id: "judgment_x", evalRunId: "evalrun_other" }));

  const judgments = await store.listJudgmentsForRun("evalrun_1");
  assert.deepEqual(
    judgments.map((j) => j.id),
    ["judgment_1", "judgment_2"]
  );
});

test("expectation results round-trip and scope by run", async () => {
  await store.saveExpectationResult({
    evalRunId: "evalrun_1",
    caseId: "evalcase_1",
    judgmentId: "judgment_1",
    matched: true,
  });
  await store.saveExpectationResult({
    evalRunId: "evalrun_other",
    caseId: "evalcase_2",
    judgmentId: "judgment_2",
    matched: false,
    detail: "drifted",
  });

  const results = await store.listExpectationResultsForRun("evalrun_1");
  assert.equal(results.length, 1);
  assert.equal(results[0].matched, true);
});
