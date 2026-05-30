import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import {
  GenerationRunsStore,
  createGenerationRunsStore,
} from "../generation-runs";

let tmpDir: string;
let store: GenerationRunsStore;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aividi-genruns-"));
  store = createGenerationRunsStore(tmpDir);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("createRun persists with assigned runId and timestamps", async () => {
  const run = await store.createRun({
    projectId: "proj_a",
    status: "queued",
  });

  assert.match(run.runId, /^genrun_/);
  assert.equal(run.projectId, "proj_a");
  assert.equal(run.status, "queued");
  assert.equal(run.createdAt, run.updatedAt);

  const read = await store.getRun(run.runId);
  assert.deepEqual(read, run);
});

test("updateRun applies patch, bumps updatedAt, preserves identity fields", async () => {
  const run = await store.createRun({
    projectId: "proj_a",
    status: "queued",
  });

  await new Promise((r) => setTimeout(r, 5));

  const updated = await store.updateRun(run.runId, {
    status: "running",
    currentStageType: "creative_plan",
    progressPercent: 20,
    message: "Planning a 60-second explainer.",
    startedAt: new Date().toISOString(),
  });

  assert.equal(updated.runId, run.runId);
  assert.equal(updated.projectId, run.projectId);
  assert.equal(updated.createdAt, run.createdAt);
  assert.notEqual(updated.updatedAt, run.updatedAt);
  assert.equal(updated.status, "running");
  assert.equal(updated.currentStageType, "creative_plan");
  assert.equal(updated.progressPercent, 20);
});

test("updateRun ignores attempts to clobber projectId/createdAt", async () => {
  const run = await store.createRun({
    projectId: "proj_a",
    status: "queued",
  });

  // Cast to `never` to simulate a hand-rolled caller (e.g. raw JSON over the
  // wire) trying to clobber identity fields the patch type forbids. The store
  // must strip them so projectId and createdAt remain stable.
  const updated = await store.updateRun(run.runId, {
    projectId: "proj_b",
    createdAt: "1999-01-01T00:00:00.000Z",
    message: "still proj_a",
  } as never);

  assert.equal(updated.projectId, "proj_a");
  assert.equal(updated.createdAt, run.createdAt);
  assert.equal(updated.message, "still proj_a");
});

test("updateRun throws when the run does not exist", async () => {
  await assert.rejects(
    () => store.updateRun("genrun_missing", { status: "failed" }),
    /generation run not found/
  );
});

test("listRunsForProject returns only that project's runs, newest first", async () => {
  const a1 = await store.createRun({ projectId: "proj_a", status: "queued" });
  await new Promise((r) => setTimeout(r, 5));
  const a2 = await store.createRun({ projectId: "proj_a", status: "queued" });
  await store.createRun({ projectId: "proj_b", status: "queued" });

  const aList = await store.listRunsForProject("proj_a");
  assert.equal(aList.length, 2);
  assert.equal(aList[0].runId, a2.runId);
  assert.equal(aList[1].runId, a1.runId);

  const bList = await store.listRunsForProject("proj_b");
  assert.equal(bList.length, 1);

  const cList = await store.listRunsForProject("proj_missing");
  assert.deepEqual(cList, []);
});

test("stages are scoped by runId and listed in order", async () => {
  const run = await store.createRun({
    projectId: "proj_a",
    status: "running",
  });

  const stageA = await store.saveStage({
    runId: run.runId,
    type: "asset_generation",
    label: "Generating visuals",
    order: 2,
    status: "queued",
    jobIds: [],
    artifactIds: [],
  });
  const stageB = await store.saveStage({
    runId: run.runId,
    type: "creative_plan",
    label: "Planning",
    order: 1,
    status: "running",
    jobIds: ["job_x"],
    artifactIds: [],
  });
  // Stage for a different run must not leak in.
  const otherRun = await store.createRun({
    projectId: "proj_a",
    status: "queued",
  });
  await store.saveStage({
    runId: otherRun.runId,
    type: "creative_plan",
    label: "Other plan",
    order: 1,
    status: "queued",
    jobIds: [],
    artifactIds: [],
  });
  assert.equal(stageA.createdAt, stageA.updatedAt);
  assert.equal(stageB.createdAt, stageB.updatedAt);

  const stages = await store.listStagesForRun(run.runId);
  assert.equal(stages.length, 2);
  assert.equal(stages[0].order, 1);
  assert.equal(stages[0].type, "creative_plan");
  assert.equal(stages[1].order, 2);
  assert.equal(stages[1].type, "asset_generation");
  for (const s of stages) {
    assert.match(s.stageId, /^genstage_/);
  }
});

test("updateStage applies patch and preserves runId", async () => {
  const run = await store.createRun({ projectId: "proj_a", status: "running" });
  const stage = await store.saveStage({
    runId: run.runId,
    type: "asset_generation",
    label: "Generating visuals",
    order: 1,
    status: "queued",
    jobIds: [],
    artifactIds: [],
  });

  const startedAt = new Date().toISOString();
  const updated = await store.updateStage(stage.stageId, {
    status: "running",
    progressPercent: 50,
    jobIds: ["job_1", "job_2"],
    artifactIds: ["asset_a"],
    message: "Generating visual 4 of 8.",
    startedAt,
  });

  assert.equal(updated.runId, run.runId);
  assert.equal(updated.status, "running");
  assert.equal(updated.progressPercent, 50);
  assert.deepEqual(updated.jobIds, ["job_1", "job_2"]);
  assert.equal(updated.stageId, stage.stageId);
  assert.equal(updated.startedAt, startedAt);
  assert.notEqual(updated.updatedAt, stage.updatedAt);
});

test("updateStage throws when the stage does not exist", async () => {
  await assert.rejects(
    () => store.updateStage("genstage_missing", { status: "failed" }),
    /generation stage not found/
  );
});

test("stage items are scoped by stageId and updatable", async () => {
  const run = await store.createRun({ projectId: "proj_a", status: "running" });
  const stage = await store.saveStage({
    runId: run.runId,
    type: "asset_generation",
    label: "Generating visuals",
    order: 1,
    status: "running",
    jobIds: [],
    artifactIds: [],
  });

  const item = await store.saveStageItem({
    stageId: stage.stageId,
    kind: "image",
    label: "Beat 1: hook still",
    status: "running",
    provider: "imagen-3",
    promptPreview: "cinematic still of...",
  });

  assert.match(item.itemId, /^genitem_/);
  assert.equal(item.createdAt, item.updatedAt);

  const completed = await store.updateStageItem(item.itemId, {
    status: "succeeded",
    assetId: "asset_42",
    progressPercent: 100,
  });
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.assetId, "asset_42");
  assert.equal(completed.stageId, stage.stageId);
  assert.notEqual(completed.updatedAt, item.updatedAt);

  // Item belonging to a different stage must not leak.
  const otherStage = await store.saveStage({
    runId: run.runId,
    type: "audio_generation",
    label: "Narration",
    order: 2,
    status: "queued",
    jobIds: [],
    artifactIds: [],
  });
  await store.saveStageItem({
    stageId: otherStage.stageId,
    kind: "audio",
    label: "Narration take 1",
    status: "queued",
  });

  const items = await store.listStageItemsForStage(stage.stageId);
  assert.equal(items.length, 1);
  assert.equal(items[0].itemId, item.itemId);
});

test("listStageItemsForStage returns items in created order", async () => {
  const run = await store.createRun({ projectId: "proj_a", status: "running" });
  const stage = await store.saveStage({
    runId: run.runId,
    type: "asset_generation",
    label: "Generating visuals",
    order: 1,
    status: "running",
    jobIds: [],
    artifactIds: [],
  });

  const first = await store.saveStageItem({
    stageId: stage.stageId,
    kind: "image",
    label: "Beat 1",
    status: "running",
  });
  await new Promise((r) => setTimeout(r, 5));
  const second = await store.saveStageItem({
    stageId: stage.stageId,
    kind: "image",
    label: "Beat 2",
    status: "running",
  });

  const items = await store.listStageItemsForStage(stage.stageId);
  assert.equal(items.length, 2);
  assert.equal(items[0].itemId, first.itemId);
  assert.equal(items[1].itemId, second.itemId);
  assert.equal(items[0].createdAt <= items[1].createdAt, true);
});

test("updateStageItem throws when the item does not exist", async () => {
  await assert.rejects(
    () => store.updateStageItem("genitem_missing", { status: "failed" }),
    /generation stage item not found/
  );
});

test("refresh recovery: a fresh store over the same dir reads prior records", async () => {
  const run = await store.createRun({ projectId: "proj_a", status: "running" });
  const stage = await store.saveStage({
    runId: run.runId,
    type: "creative_plan",
    label: "Planning",
    order: 1,
    status: "running",
    jobIds: [],
    artifactIds: [],
  });
  await store.saveStageItem({
    stageId: stage.stageId,
    kind: "image",
    label: "Beat 1",
    status: "running",
  });

  const reopened = createGenerationRunsStore(tmpDir);

  const recoveredRun = await reopened.getRun(run.runId);
  assert.ok(recoveredRun);
  assert.equal(recoveredRun!.runId, run.runId);

  const stages = await reopened.listStagesForRun(run.runId);
  assert.equal(stages.length, 1);
  assert.equal(stages[0].type, "creative_plan");

  const items = await reopened.listStageItemsForStage(stage.stageId);
  assert.equal(items.length, 1);
  assert.equal(items[0].label, "Beat 1");
});
