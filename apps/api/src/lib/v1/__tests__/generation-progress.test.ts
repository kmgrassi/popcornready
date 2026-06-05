import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveActor } from "../actor";
import {
  GenerationDeps,
  createGenerationJob,
  runGenerationJob,
} from "../generation";
import { createGenerationRunExecution } from "../generation/run-execution";
import {
  RunProgressEmitter,
  RunStageHandle,
  RunStageItemHandle,
  noopProgressEmitter,
  toErrorSummary,
} from "../generation-progress";
import {
  assemblePayload,
  createGenerationRunsStore,
  createPersistedRunProgressEmitter,
  createRunWithSeedStages,
} from "../generation-runs";
import { createFileJudgmentStore } from "../../eval/judgment-store";
import { V1Store, createStore } from "../store";
import {
  AspectRatio,
  BriefVersion,
  SCHEMA,
  V1Asset,
  V1Project,
  VideoBriefInput,
} from "@popcorn/shared/v1/types";
import { LOCAL_WORKSPACE_ID } from "../../api/v1/auth";

// --- Recording emitter -----------------------------------------------------

// Captures the full event stream as ordered records, so tests can assert the
// exact sequence the generation code emits — `runs.updateRun`,
// `stages.begin / update / succeed / fail`, and `items.start / succeed / fail`.

type EventRecord =
  | { kind: "run_update"; patch: { progressPercent?: number; message?: string } }
  | { kind: "stage_begin"; type: string; label?: string; message?: string }
  | { kind: "stage_update"; type: string; patch: { progressPercent?: number; message?: string } }
  | { kind: "stage_attach_job"; type: string; jobId: string }
  | { kind: "stage_attach_artifact"; type: string; artifactId: string }
  | { kind: "stage_succeed"; type: string; message?: string }
  | { kind: "stage_fail"; type: string; code: string; message: string; retryable: boolean }
  | { kind: "stage_cancel"; type: string; message?: string }
  | { kind: "item_start"; stageType: string; itemKind: string; label: string; provider?: string }
  | { kind: "item_update"; itemId: string; patch: { progressPercent?: number; message?: string } }
  | { kind: "item_succeed"; itemId: string; assetId?: string; artifactId?: string }
  | { kind: "item_fail"; itemId: string; code: string; message: string; retryable: boolean };

function createRecordingEmitter(): { emitter: RunProgressEmitter; events: EventRecord[] } {
  const events: EventRecord[] = [];
  let nextItemId = 1;

  function makeItem(stageType: string, label: string, provider: string | undefined): RunStageItemHandle {
    const itemId = `item_${nextItemId++}`;
    events.push({ kind: "item_start", stageType, itemKind: "", label, provider });
    return {
      itemId,
      async update(patch) {
        events.push({ kind: "item_update", itemId, patch });
      },
      async succeed(opts) {
        events.push({
          kind: "item_succeed",
          itemId,
          assetId: opts?.assetId,
          artifactId: opts?.artifactId,
        });
      },
      async fail(error) {
        events.push({
          kind: "item_fail",
          itemId,
          code: error.code,
          message: error.message,
          retryable: error.retryable ?? false,
        });
      },
    };
  }

  function makeStage(type: string): RunStageHandle {
    return {
      type: type as RunStageHandle["type"],
      async update(patch) {
        events.push({ kind: "stage_update", type, patch });
      },
      async startItem(opts) {
        const item = makeItem(type, opts.label, opts.provider);
        // Patch the most recent item_start so it carries the actual kind.
        const last = events[events.length - 1];
        if (last && last.kind === "item_start") last.itemKind = opts.kind;
        return item;
      },
      async attachJob(jobId) {
        events.push({ kind: "stage_attach_job", type, jobId });
      },
      async attachArtifact(artifactId) {
        events.push({ kind: "stage_attach_artifact", type, artifactId });
      },
      async succeed(opts) {
        events.push({ kind: "stage_succeed", type, message: opts?.message });
      },
      async fail(error) {
        events.push({
          kind: "stage_fail",
          type,
          code: error.code,
          message: error.message,
          retryable: error.retryable ?? false,
        });
      },
      async cancel(opts) {
        events.push({ kind: "stage_cancel", type, message: opts?.message });
      },
    };
  }

  const emitter: RunProgressEmitter = {
    async beginStage(type, opts) {
      events.push({ kind: "stage_begin", type, label: opts?.label, message: opts?.message });
      return makeStage(type);
    },
    async updateRun(patch) {
      events.push({ kind: "run_update", patch });
    },
  };

  return { emitter, events };
}

// --- Shared fixtures -------------------------------------------------------

const fakeDeps: GenerationDeps = {
  async planEdit(input) {
    return {
      targetLengthSec: input.targetLengthSec,
      style: input.style,
      aspectRatio: input.aspectRatio as AspectRatio,
      beats: [{ name: "hook", durationSec: 3, intent: "grab attention" }],
    };
  },
  async selectClips({ plan, clips }) {
    const visual = clips.filter((c) => (c.kind || "video") !== "audio");
    return {
      aspectRatio: plan.aspectRatio,
      fps: 30,
      segments: visual.map((c) => ({
        id: "",
        clipId: c.id,
        sourceInSec: 0,
        sourceOutSec: Math.min(2, c.durationSec),
        role: "hook",
        reason: "test selection",
      })),
    };
  },
  async critique() {
    return {
      report: {
        scores: {
          hook_score: 8,
          clarity_score: 8,
          pacing_score: 8,
          visual_variety: 8,
          script_coverage: 8,
          emotional_arc: 8,
          repetition_penalty: 0,
        },
        summary: "looks good",
      },
      patches: [],
    };
  },
};

async function withStore(fn: (store: V1Store) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "popcornready-progress-"));
  try {
    await fn(createStore(dir));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const NOW = "2026-05-29T12:00:00.000Z";

async function seedProject(store: V1Store, id = "proj_test"): Promise<V1Project> {
  return store.saveProject({
    id,
    schemaVersion: SCHEMA.project,
    workspaceId: LOCAL_WORKSPACE_ID,
    name: "Test project",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
  });
}

async function seedBrief(
  store: V1Store,
  projectId: string,
  brief?: Partial<VideoBriefInput>,
  id = "briefv_test"
): Promise<BriefVersion> {
  return store.saveBriefVersion({
    id,
    schemaVersion: SCHEMA.briefVersion,
    projectId,
    brief: {
      goal: "Make a punchy teaser.",
      targetLengthSec: 15,
      aspectRatio: "9:16",
      ...brief,
    },
    createdAt: NOW,
  });
}

async function seedAsset(
  store: V1Store,
  projectId: string,
  overrides: Partial<V1Asset> & { id: string }
): Promise<V1Asset> {
  return store.saveAsset({
    schemaVersion: SCHEMA.asset,
    projectId,
    workspaceId: LOCAL_WORKSPACE_ID,
    kind: "video",
    status: "ready",
    filename: `${overrides.id}.mp4`,
    url: `/uploads/${overrides.id}.mp4`,
    durationSec: 5,
    source: "upload",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

// --- Tests -----------------------------------------------------------------

test("runGenerationJob without an emitter still completes (no-op default)", async () => {
  await withStore(async (store) => {
    const project = await seedProject(store);
    const brief = await seedBrief(store, project.id);
    await seedAsset(store, project.id, { id: "asset_1" });

    const job = await createGenerationJob({
      store,
      actor: resolveActor(),
      projectId: project.id,
      body: { briefVersionId: brief.id, assetIds: ["asset_1"] },
    });

    // No `progress` argument → falls through to `noopProgressEmitter`.
    const done = await runGenerationJob(store, job.id, fakeDeps);
    assert.equal(done.status, "succeeded");
  });
});

test("runGenerationJob emits stages in the documented order on success", async () => {
  await withStore(async (store) => {
    const project = await seedProject(store);
    const brief = await seedBrief(store, project.id);
    await seedAsset(store, project.id, { id: "asset_1" });

    const job = await createGenerationJob({
      store,
      actor: resolveActor(),
      projectId: project.id,
      body: { briefVersionId: brief.id, assetIds: ["asset_1"] },
    });

    const { emitter, events } = createRecordingEmitter();
    const done = await runGenerationJob(store, job.id, fakeDeps, emitter);
    assert.equal(done.status, "succeeded");

    // The stages we begin, in order. asset_generation is owned by the asset
    // pipeline (createGeneratedAsset), not by runGenerationJob, so it does not
    // appear here — runGenerationJob only emits the timeline-side stages.
    const stageBeginOrder = events
      .filter((e) => e.kind === "stage_begin")
      .map((e) => (e as Extract<EventRecord, { kind: "stage_begin" }>).type);
    assert.deepEqual(stageBeginOrder, [
      "creative_plan",
      "timeline_assembly",
      "quality_review",
    ]);

    // Every begun stage is succeeded (no leaked open stages on the happy path).
    const stageSucceeds = events
      .filter((e) => e.kind === "stage_succeed")
      .map((e) => (e as Extract<EventRecord, { kind: "stage_succeed" }>).type);
    assert.deepEqual(stageSucceeds, [
      "creative_plan",
      "timeline_assembly",
      "quality_review",
    ]);

    // Stages attach the underlying generation job so the run can aggregate.
    const attached = events
      .filter((e) => e.kind === "stage_attach_job")
      .map((e) => (e as Extract<EventRecord, { kind: "stage_attach_job" }>).jobId);
    assert.ok(attached.length >= 3 && attached.every((id) => id === job.id));

    // timeline_assembly produces a `timeline` stage item that succeeds.
    const tlItemStart = events.find(
      (e) =>
        e.kind === "item_start" &&
        e.stageType === "timeline_assembly" &&
        e.itemKind === "timeline"
    );
    assert.ok(tlItemStart, "expected timeline stage item to start");

    // run_update fires with the documented run-level milestones.
    const runPercents = events
      .filter((e) => e.kind === "run_update")
      .map(
        (e) =>
          (e as Extract<EventRecord, { kind: "run_update" }>).patch.progressPercent
      )
      .filter((p): p is number => typeof p === "number");
    assert.ok(runPercents.includes(20), "creative_plan run percent");
    assert.ok(runPercents.includes(50), "timeline_assembly run percent");
    assert.ok(runPercents.includes(75), "quality_review run percent");
    assert.ok(runPercents.includes(100), "completion run percent");
  });
});

test("runGenerationJob persists evidence artifacts for normal run execution", async () => {
  await withStore(async (store) => {
    const project = await seedProject(store);
    const brief = await seedBrief(store, project.id);
    await seedAsset(store, project.id, { id: "asset_1" });

    const job = await createGenerationJob({
      store,
      actor: resolveActor(),
      projectId: project.id,
      body: { briefVersionId: brief.id, assetIds: ["asset_1"] },
    });

    const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "popcornready-run-artifacts-"));
    try {
      const runStore = createGenerationRunsStore(runDir);
      const runExecution = await createGenerationRunExecution({
        projectId: project.id,
        briefVersionId: brief.id,
        body: { briefVersionId: brief.id },
        runStore,
        judgmentStore: createFileJudgmentStore(runDir),
      });

      const done = await runGenerationJob(
        store,
        job.id,
        fakeDeps,
        runExecution.progress,
        runExecution.execution
      );
      assert.equal(done.status, "succeeded");

      const stages = await runStore.listStagesForRun(runExecution.runId);
      const planStage = stages.find((stage) => stage.type === "creative_plan");
      const timelineStage = stages.find((stage) => stage.type === "timeline_assembly");
      assert.equal(planStage?.artifactIds.length, 1);
      assert.equal(timelineStage?.artifactIds.length, 1);

      const planArtifact = await runStore.getStageArtifact(planStage!.artifactIds[0]);
      const timelineArtifact = await runStore.getStageArtifact(timelineStage!.artifactIds[0]);
      assert.equal(planArtifact?.kind, "timeline");
      assert.equal(timelineArtifact?.kind, "timeline");
      assert.equal(planArtifact?.stageId, planStage!.stageId);
      assert.equal(timelineArtifact?.stageId, timelineStage!.stageId);
    } finally {
      await fs.rm(runDir, { recursive: true, force: true });
    }
  });
});

test("runGenerationJob pauses after a persisted gated stage instead of advancing", async () => {
  await withStore(async (store) => {
    const project = await seedProject(store);
    const brief = await seedBrief(store, project.id);
    await seedAsset(store, project.id, { id: "asset_1" });

    const job = await createGenerationJob({
      store,
      actor: resolveActor(),
      projectId: project.id,
      body: { briefVersionId: brief.id, assetIds: ["asset_1"] },
    });

    const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "popcornready-run-gates-"));
    try {
      const runStore = createGenerationRunsStore(runDir);
      const runPayload = await createRunWithSeedStages({
        store: runStore,
        projectId: project.id,
        body: {
          briefVersionId: brief.id,
          reviewGates: ["creative_plan"],
        },
      });
      const emitter = createPersistedRunProgressEmitter(runStore, runPayload.run.runId);

      const paused = await runGenerationJob(store, job.id, fakeDeps, emitter);
      // The worker stopped at the gate, but the job is rolled back to `queued`
      // so the resume path (runGenerationJob runs only `queued` jobs) can
      // re-enter it on approve rather than leaving it stuck `running`.
      assert.equal(paused.status, "queued");
      assert.equal(paused.result, null);

      const payload = await assemblePayload(runStore, runPayload.run.runId);
      assert.ok(payload);
      assert.equal(payload!.run.reviewGate?.state, "awaiting_review");
      assert.equal(payload!.run.reviewGate?.stageType, "creative_plan");
      assert.equal(
        payload!.stages.find((stage) => stage.type === "creative_plan")?.status,
        "succeeded"
      );
      assert.equal(
        payload!.stages.find((stage) => stage.type === "timeline_assembly")?.status,
        "queued"
      );
    } finally {
      await fs.rm(runDir, { recursive: true, force: true });
    }
  });
});

test("runGenerationJob fails the active stage when critique yields an empty timeline", async () => {
  await withStore(async (store) => {
    const project = await seedProject(store);
    const brief = await seedBrief(store, project.id);
    await seedAsset(store, project.id, { id: "asset_1" });

    const job = await createGenerationJob({
      store,
      actor: resolveActor(),
      projectId: project.id,
      body: { briefVersionId: brief.id, assetIds: ["asset_1"] },
    });

    // Patch deps so critique removes all segments — surfaces a
    // `timeline_invalid` failure during quality_review.
    const breakingDeps: GenerationDeps = {
      ...fakeDeps,
      async critique({ timeline }) {
        return {
          report: {
            scores: {
              hook_score: 1,
              clarity_score: 1,
              pacing_score: 1,
              visual_variety: 1,
              script_coverage: 1,
              emotional_arc: 1,
              repetition_penalty: 9,
            },
            summary: "all bad",
          },
          patches: timeline.segments.map((seg) => ({
            op: "remove_segment" as const,
            segmentId: seg.id,
            reason: "test removal",
          })),
        };
      },
    };

    const { emitter, events } = createRecordingEmitter();
    const done = await runGenerationJob(store, job.id, breakingDeps, emitter);
    assert.equal(done.status, "failed");
    assert.equal(done.error?.code, "timeline_invalid");

    // The failure must be attributed to the stage that was active when it
    // happened: quality_review.
    const fails = events.filter(
      (e) => e.kind === "stage_fail"
    ) as Extract<EventRecord, { kind: "stage_fail" }>[];
    assert.equal(fails.length, 1);
    assert.equal(fails[0].type, "quality_review");
    assert.equal(fails[0].code, "timeline_invalid");
    assert.equal(
      fails[0].retryable,
      false,
      "timeline_invalid is structural and not retryable"
    );

    // Earlier stages still cleanly succeeded.
    const succeeded = (
      events.filter((e) => e.kind === "stage_succeed") as Extract<
        EventRecord,
        { kind: "stage_succeed" }
      >[]
    ).map((e) => e.type);
    assert.deepEqual(succeeded, ["creative_plan", "timeline_assembly"]);
  });
});

test("noopProgressEmitter is fully no-op and accepts every call", async () => {
  // Guard against accidental side effects in the no-op default; PR2's
  // persisting emitter is supposed to be the only one that actually writes.
  const stage = await noopProgressEmitter.beginStage("creative_plan");
  await stage.update({ progressPercent: 50, message: "halfway" });
  await stage.attachJob("job_x");
  await stage.attachArtifact("art_x");
  const item = await stage.startItem({ kind: "image", label: "x" });
  await item.update({ progressPercent: 90 });
  await item.succeed({ assetId: "asset_y" });
  await stage.succeed();
  await stage.fail({ code: "x", message: "y", retryable: false });
  await stage.cancel();
  await noopProgressEmitter.updateRun({ progressPercent: 0 });
});

// --- toErrorSummary --------------------------------------------------------

test("toErrorSummary marks structural failures as non-retryable", () => {
  const summary = toErrorSummary({ code: "asset_not_ready", message: "no" });
  assert.equal(summary.code, "asset_not_ready");
  assert.equal(summary.retryable, false);
});

test("toErrorSummary marks transient provider failures as retryable", () => {
  const summary = toErrorSummary({
    code: "provider_timeout",
    message: "openai timed out",
  });
  assert.equal(summary.retryable, true);
});

test("toErrorSummary honours an explicit override", () => {
  const summary = toErrorSummary(
    { code: "asset_not_ready", message: "no" },
    { retryable: true }
  );
  assert.equal(summary.retryable, true);
});

test("toErrorSummary defaults unknown codes to non-retryable", () => {
  const summary = toErrorSummary({
    code: "something_we_havent_seen",
    message: "?",
  });
  assert.equal(summary.retryable, false);
});

test("toErrorSummary falls back when the error has no code", () => {
  const summary = toErrorSummary(new Error("kaboom"));
  assert.equal(summary.code, "internal_error");
  assert.equal(summary.message, "kaboom");
  assert.equal(summary.retryable, false);
});
