import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import type { EvalRun, Judgment } from "@popcorn/eval";

import { createFileEvalStore, type EvalStore } from "../store";

// Ids are DB-generated (uuid). The file store stands in for Postgres and assigns
// the uuid on insert, so create inputs never carry an id and callers read the
// assigned id back off the returned entity.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let tmpDir: string;
let store: EvalStore;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "popcornready-eval-store-"));
  store = createFileEvalStore(tmpDir);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// Run/judgment fixtures omit the id (the store assigns it). evalRunId/suiteId are
// filled in by the caller from real returned ids.
function makeRun(overrides: Partial<Omit<EvalRun, "id">> = {}): Omit<EvalRun, "id"> {
  return {
    source: "suite",
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
    id: "",
    evaluatorId: "story_arc.v1",
    rubricVersion: "v1",
    judgeModel: "test-model",
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

test("createSuite assigns a uuid id and round-trips", async () => {
  const suite = await store.createSuite({ name: "Long-form core", description: "desc" });
  assert.match(suite.id, UUID_RE);
  const read = await store.getSuite(suite.id);
  assert.deepEqual(read, suite);
});

test("listSuites returns all saved suites", async () => {
  await store.createSuite({ name: "A" });
  await store.createSuite({ name: "B" });
  const suites = await store.listSuites();
  assert.equal(suites.length, 2);
});

test("getSuite returns null for an unknown id", async () => {
  assert.equal(await store.getSuite("evalsuite_missing"), null);
});

test("saveCase assigns a uuid id, defaults artifacts and scopes by suite", async () => {
  const suite = await store.createSuite({ name: "Core" });
  const other = await store.createSuite({ name: "Other suite" });
  const created = await store.saveCase({
    suiteId: suite.id,
    label: "Launch arc",
    stimulus: { kind: "brief", goal: "g", targetLengthSec: 60, style: "doc", aspectRatio: "16:9" },
    stagesToRun: ["creative_plan"],
  });
  assert.match(created.id, UUID_RE);
  assert.deepEqual(created.artifacts, []);

  await store.saveCase({
    suiteId: other.id,
    label: "Other",
    stimulus: { kind: "brief", goal: "g", targetLengthSec: 60, style: "doc", aspectRatio: "16:9" },
    stagesToRun: ["creative_plan"],
  });

  const cases = await store.listCasesForSuite(suite.id);
  assert.equal(cases.length, 1);
  assert.equal(cases[0].id, created.id);
});

test("saveRun assigns a uuid id; getRun + listRunsForSuite (newest first)", async () => {
  const suite = await store.createSuite({ name: "Core" });
  const older = await store.saveRun(
    makeRun({ suiteId: suite.id, createdAt: "2026-06-01T00:00:00.000Z" })
  );
  const newer = await store.saveRun(
    makeRun({ suiteId: suite.id, createdAt: "2026-06-04T00:00:00.000Z" })
  );
  assert.match(older.id, UUID_RE);

  assert.deepEqual(await store.getRun(older.id), older);
  const runs = await store.listRunsForSuite(suite.id);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].id, newer.id);
  assert.equal(runs[1].id, older.id);
});

test("getRun returns null for an unknown id", async () => {
  assert.equal(await store.getRun("evalrun_missing"), null);
});

test("saveJudgment is append-only: every save gets a fresh id", async () => {
  const a = await store.saveJudgment(makeJudgment());
  const b = await store.saveJudgment(makeJudgment());
  assert.match(a.id, UUID_RE);
  assert.match(b.id, UUID_RE);
  assert.notEqual(a.id, b.id);
});

test("listJudgmentsForRun scopes by run and orders oldest-first", async () => {
  const runId = "11111111-1111-1111-1111-111111111111";
  await store.saveJudgment(
    makeJudgment({ evalRunId: runId, createdAt: "2026-06-04T10:00:02.000Z" })
  );
  await store.saveJudgment(
    makeJudgment({ evalRunId: runId, createdAt: "2026-06-04T10:00:01.000Z" })
  );
  await store.saveJudgment(makeJudgment({ evalRunId: "evalrun_other" }));

  const judgments = await store.listJudgmentsForRun(runId);
  assert.deepEqual(
    judgments.map((j) => j.createdAt),
    ["2026-06-04T10:00:01.000Z", "2026-06-04T10:00:02.000Z"]
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
