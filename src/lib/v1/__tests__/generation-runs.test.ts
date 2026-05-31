import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { ApiError } from "../errors";
import {
  GenerationRunsStore,
  assemblePayload,
  createGenerationRunsStore,
  createRunWithSeedStages,
  requireRun,
} from "../generation-runs";

let tmpDir: string;
let store: GenerationRunsStore;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "popcornready-genruns-"));
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
  await new Promise((r) => setTimeout(r, 5));
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
  await new Promise((r) => setTimeout(r, 5));

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


test("createRunWithSeedStages returns a queued run with all seed stages in order", async () => {
  const payload = await createRunWithSeedStages({
    store,
    projectId: "proj_seed_a",
    body: { briefVersionId: "briefv_1" },
  });

  assert.equal(payload.run.projectId, "proj_seed_a");
  assert.equal(payload.run.status, "queued");
  assert.equal(payload.run.currentStageType, "brief_intake");
  assert.match(payload.run.runId, /^genrun_/);

  const types = payload.stages.map((s) => s.type);
  assert.deepEqual(types, [
    "brief_intake",
    "creative_plan",
    "asset_generation",
    "audio_generation",
    "timeline_assembly",
    "quality_review",
    "export",
    "ready",
  ]);
  for (const stage of payload.stages) {
    assert.equal(stage.status, "queued");
    assert.equal(stage.runId, payload.run.runId);
    assert.deepEqual(stage.jobIds, []);
    assert.deepEqual(stage.artifactIds, []);
  }

  assert.deepEqual(payload.stageItems, []);
  assert.deepEqual(payload.resultArtifacts, []);
});

test("createRunWithSeedStages stamps configured review gates on matching stages", async () => {
  const payload = await createRunWithSeedStages({
    store,
    projectId: "proj_seed_gates",
    body: {
      reviewGates: ["creative_plan", "asset_generation", "timeline_assembly"],
    },
  });

  assert.deepEqual(payload.run.reviewGates, [
    "creative_plan",
    "asset_generation",
    "timeline_assembly",
  ]);

  const gatedStages = payload.stages
    .filter((stage) => stage.isReviewGate)
    .map((stage) => stage.type);
  assert.deepEqual(gatedStages, [
    "creative_plan",
    "asset_generation",
    "timeline_assembly",
  ]);
});

test("createRunWithSeedStages treats omitted or empty reviewGates as YOLO runs", async () => {
  const omitted = await createRunWithSeedStages({
    store,
    projectId: "proj_seed_no_gates",
    body: {},
  });
  const empty = await createRunWithSeedStages({
    store,
    projectId: "proj_seed_empty_gates",
    body: { reviewGates: [] },
  });

  assert.equal(omitted.run.reviewGates, undefined);
  assert.equal(empty.run.reviewGates, undefined);
  assert.equal(
    omitted.stages.some((stage) => stage.isReviewGate),
    false
  );
  assert.equal(
    empty.stages.some((stage) => stage.isReviewGate),
    false
  );
});

test("createRunWithSeedStages rejects invalid and non-gateable review gates", async () => {
  await assert.rejects(
    () =>
      createRunWithSeedStages({
        store,
        projectId: "proj_seed_bad_gate",
        body: { reviewGates: ["creative_plan", "ready"] },
      }),
    (err) => err instanceof ApiError && err.code === "validation_failed"
  );

  await assert.rejects(
    () =>
      createRunWithSeedStages({
        store,
        projectId: "proj_seed_bad_gate_type",
        body: { reviewGates: "creative_plan" },
      }),
    (err) => err instanceof ApiError && err.code === "validation_failed"
  );
});

test("createRunWithSeedStages treats a null body as an empty payload", async () => {
  const payload = await createRunWithSeedStages({
    store,
    projectId: "proj_seed_null",
    body: null as unknown as { briefVersionId?: string },
  });

  assert.equal(payload.run.projectId, "proj_seed_null");
  assert.equal(payload.run.status, "queued");
  assert.equal(payload.run.currentStageType, "brief_intake");
  assert.equal(payload.run.briefVersionId, undefined);
});

test("createRunWithSeedStages persists run + stages so polling sees the same data", async () => {
  const created = await createRunWithSeedStages({
    store,
    projectId: "proj_seed_b",
    body: {},
  });

  const polled = await assemblePayload(store, created.run.runId);
  assert.ok(polled, "payload should be loadable after creation");
  assert.equal(polled!.run.runId, created.run.runId);
  assert.equal(polled!.stages.length, created.stages.length);
  assert.deepEqual(
    polled!.stages.map((s) => s.order),
    [0, 1, 2, 3, 4, 5, 6, 7],
    "stages should be sorted by order"
  );
});

test("assemblePayload collects result artifacts from stages and matches stage items", async () => {
  const created = await createRunWithSeedStages({
    store,
    projectId: "proj_seed_c",
    body: {},
  });

  const assetStage = created.stages.find((s) => s.type === "asset_generation")!;
  const exportStage = created.stages.find((s) => s.type === "export")!;

  // Simulate PR 3 emission: completed item linked to an artifact, and a
  // stage-level export artifact with no matching item.
  const item = await store.saveStageItem({
    stageId: assetStage.stageId,
    kind: "image",
    label: "Visual 1 of 1",
    status: "succeeded",
    assetId: "asset_img1",
    artifactId: "art_img1",
  });
  await store.updateStage(assetStage.stageId, {
    status: "succeeded",
    artifactIds: [...assetStage.artifactIds, "art_img1"],
  });
  await store.updateStage(exportStage.stageId, {
    status: "succeeded",
    artifactIds: [...exportStage.artifactIds, "art_export1"],
  });

  const payload = await assemblePayload(store, created.run.runId);
  assert.ok(payload);
  assert.equal(payload!.stageItems.length, 1);
  assert.equal(payload!.resultArtifacts.length, 2);

  const imageArt = payload!.resultArtifacts.find((a) => a.artifactId === "art_img1");
  assert.ok(imageArt, "image artifact should be in result list");
  assert.equal(imageArt!.kind, "image");
  assert.equal(imageArt!.itemId, item.itemId);
  assert.equal(imageArt!.assetId, "asset_img1");

  const exportArt = payload!.resultArtifacts.find(
    (a) => a.artifactId === "art_export1"
  );
  assert.ok(exportArt, "export artifact should be in result list");
  assert.equal(exportArt!.kind, "export");
  assert.equal(exportArt!.itemId, undefined);
});

test("requireRun returns the payload for a matching project", async () => {
  const created = await createRunWithSeedStages({
    store,
    projectId: "proj_match",
    body: {},
  });
  const payload = await assemblePayload(store, created.run.runId);
  const verified = requireRun(payload, created.run.runId, "proj_match");
  assert.equal(verified.run.runId, created.run.runId);
});

test("requireRun throws not_found for unknown runs", async () => {
  const payload = await assemblePayload(store, "run_missing");
  assert.equal(payload, null);
  assert.throws(
    () => requireRun(payload, "run_missing", "proj_any"),
    (err) => err instanceof ApiError && err.code === "not_found"
  );
});

test("requireRun throws not_found when projectId does not match (cross-project leak)", async () => {
  const created = await createRunWithSeedStages({
    store,
    projectId: "proj_owner",
    body: {},
  });
  const payload = await assemblePayload(store, created.run.runId);
  assert.throws(
    () => requireRun(payload, created.run.runId, "proj_intruder"),
    (err) => err instanceof ApiError && err.code === "not_found"
  );
});

test("ApiError not_implemented serialises as 501 with a clear envelope", () => {
  const err = new ApiError("not_implemented", "Cancel is not supported for generation runs yet.", {
    supported: false,
    action: "cancel",
  } as never);
  assert.equal(err.status, 501);
  const envelope = err.envelope("req_test");
  assert.equal(envelope.error.code, "not_implemented");
  assert.equal(envelope.error.requestId, "req_test");
  assert.deepEqual(envelope.error.details, {
    supported: false,
    action: "cancel",
  });
});
