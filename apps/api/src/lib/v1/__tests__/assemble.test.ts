import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const previousLogLevel = process.env.POPCORN_READY_LOG_LEVEL;
test.before(() => {
  process.env.POPCORN_READY_LOG_LEVEL = "silent";
});
test.after(() => {
  if (previousLogLevel === undefined) delete process.env.POPCORN_READY_LOG_LEVEL;
  else process.env.POPCORN_READY_LOG_LEVEL = previousLogLevel;
});

import { ApiError } from "../errors";
import {
  AssembleDeps,
  CritiqueDeps,
  resolveAssemble,
  runAssemble,
  runTimelineCritique,
} from "../assemble";
import { V1Store, createStore } from "../store";
import { planBeats } from "@popcorn/shared/types";
import {
  AspectRatio,
  SCHEMA,
  V1Asset,
  V1Project,
  VersionedTimeline,
} from "@popcorn/shared/v1/types";

const NOW = "2026-06-05T12:00:00.000Z";

// Offline, deterministic stand-in for the model-backed selectClips. One segment
// per visual clip, so we exercise resolve -> select -> persist without network.
const fakeAssembleDeps: AssembleDeps = {
  async selectClips({ plan, clips }) {
    const visual = clips.filter((c) => (c.kind || "video") !== "audio");
    const beats = planBeats(plan);
    return {
      aspectRatio: plan.aspectRatio,
      fps: 30,
      segments: visual.map((c) => ({
        id: "",
        clipId: c.id,
        sourceInSec: 0,
        sourceOutSec: Math.min(2, c.durationSec),
        role: beats[0]?.name || "hook",
        beatId: beats[0]?.id,
        reason: `select ${c.id}`,
      })),
    };
  },
};

const fakeCritiqueDeps: CritiqueDeps = {
  async critique() {
    return {
      report: {
        scores: {
          hook_score: 7,
          clarity_score: 7,
          pacing_score: 7,
          visual_variety: 7,
          script_coverage: 7,
          emotional_arc: 7,
          repetition_penalty: 1,
        },
        summary: "solid cut",
      },
      patches: [
        {
          op: "set_trim",
          segmentId: "seg_1",
          sourceInSec: 0,
          sourceOutSec: 1.5,
          reason: "tighten the hook",
        },
      ],
    };
  },
};

async function withStore(fn: (store: V1Store) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "popcornready-assemble-"));
  try {
    await fn(createStore(dir));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function seedProject(store: V1Store, id = "proj_test"): Promise<V1Project> {
  return store.saveProject({
    id,
    schemaVersion: SCHEMA.project,
    workspaceId: "dev_workspace",
    name: "Test project",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
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
    workspaceId: "dev_workspace",
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

const rawPlan = {
  targetLengthSec: 12,
  style: "punchy",
  aspectRatio: "9:16" as AspectRatio,
  beats: [{ name: "hook", durationSec: 4, intent: "grab attention" }],
};

// --- assemble happy path: persists a VersionedTimeline ---------------------

test("assemble runs selectClips and persists a VersionedTimeline", async () => {
  await withStore(async (store) => {
    const project = await seedProject(store);
    await seedAsset(store, project.id, { id: "asset_1" });
    await seedAsset(store, project.id, { id: "asset_2" });

    const input = await resolveAssemble(store, "dev_workspace", project.id, {
      plan: rawPlan,
      assetIds: ["asset_1", "asset_2"],
      goal: "test assemble",
    });
    assert.equal(input.assetIds.length, 2);
    assert.ok(input.briefVersionId, "synthesizes a brief version for provenance");

    const result = await runAssemble({
      store,
      jobId: "job_assemble_1",
      input,
      projectId: project.id,
      deps: fakeAssembleDeps,
    });

    assert.ok(result.timelineId, "returns a persisted timeline id");
    assert.equal(result.segmentCount, 2);

    const timeline = (await store.getTimeline(result.timelineId)) as VersionedTimeline;
    assert.ok(timeline, "timeline is persisted in the store");
    assert.equal(timeline.projectId, project.id);
    assert.equal(timeline.segments.length, 2);
    assert.deepEqual(timeline.provenance.sourceAssetIds, ["asset_1", "asset_2"]);
    assert.equal(timeline.createdBy.jobId, "job_assemble_1");
    assert.ok(timeline.derivedFrom?.editGraphId, "links to its edit graph");
  });
});

test("store lists project timelines newest first and scoped by project", async () => {
  await withStore(async (store) => {
    const project = await seedProject(store);
    const otherProject = await seedProject(store, "proj_other");
    await seedAsset(store, project.id, { id: "asset_1" });
    await seedAsset(store, otherProject.id, { id: "asset_other" });

    const firstInput = await resolveAssemble(store, "dev_workspace", project.id, {
      plan: rawPlan,
      assetIds: ["asset_1"],
    });
    const first = await runAssemble({
      store,
      jobId: "job_assemble_first",
      input: firstInput,
      projectId: project.id,
      deps: fakeAssembleDeps,
    });

    await new Promise((resolve) => setTimeout(resolve, 2));

    const secondInput = await resolveAssemble(store, "dev_workspace", project.id, {
      plan: rawPlan,
      assetIds: ["asset_1"],
    });
    const second = await runAssemble({
      store,
      jobId: "job_assemble_second",
      input: secondInput,
      projectId: project.id,
      deps: fakeAssembleDeps,
    });

    const otherInput = await resolveAssemble(store, "dev_workspace", otherProject.id, {
      plan: rawPlan,
      assetIds: ["asset_other"],
    });
    await runAssemble({
      store,
      jobId: "job_assemble_other",
      input: otherInput,
      projectId: otherProject.id,
      deps: fakeAssembleDeps,
    });

    const timelines = await store.listTimelinesForProject(project.id);
    assert.deepEqual(
      timelines.map((timeline) => timeline.id),
      [second.timelineId, first.timelineId]
    );
  });
});

// --- assemble precondition: no plan and no composition ---------------------

test("assemble with neither plan nor composition is a structured error", async () => {
  await withStore(async (store) => {
    const project = await seedProject(store);
    await seedAsset(store, project.id, { id: "asset_1" });

    await assert.rejects(
      () => resolveAssemble(store, "dev_workspace", project.id, { assetIds: ["asset_1"] }),
      (err: unknown) => err instanceof ApiError && err.code === "validation_failed"
    );
  });
});

// --- assemble precondition: no ready visual assets -------------------------

test("assemble with no ready visual assets is a structured error", async () => {
  await withStore(async (store) => {
    const project = await seedProject(store);
    // Only an audio asset is ready — no visual to cut against.
    await seedAsset(store, project.id, { id: "audio_1", kind: "audio" });

    await assert.rejects(
      () => resolveAssemble(store, "dev_workspace", project.id, { plan: rawPlan }),
      (err: unknown) => err instanceof ApiError && err.code === "validation_failed"
    );
  });
});

// --- critique happy path ---------------------------------------------------

test("critique runs over a persisted timeline and returns scores + patches", async () => {
  await withStore(async (store) => {
    const project = await seedProject(store);
    await seedAsset(store, project.id, { id: "asset_1" });

    const input = await resolveAssemble(store, "dev_workspace", project.id, {
      plan: rawPlan,
      assetIds: ["asset_1"],
    });
    const assembled = await runAssemble({
      store,
      jobId: "job_assemble_2",
      input,
      projectId: project.id,
      deps: fakeAssembleDeps,
    });

    const result = await runTimelineCritique({
      store,
      workspaceId: "dev_workspace",
      projectId: project.id,
      timelineId: assembled.timelineId,
      deps: fakeCritiqueDeps,
    });

    assert.equal(result.timelineId, assembled.timelineId);
    assert.equal(result.report.scores.hook_score, 7);
    assert.equal(result.report.summary, "solid cut");
    assert.equal(result.patches.length, 1);
    assert.equal(result.patches[0]?.op, "set_trim");
  });
});

// --- critique precondition: unknown timeline -------------------------------

test("critique of an unknown timeline is a structured not_found", async () => {
  await withStore(async (store) => {
    const project = await seedProject(store);

    await assert.rejects(
      () =>
        runTimelineCritique({
          store,
          workspaceId: "dev_workspace",
          projectId: project.id,
          timelineId: "timeline_does_not_exist",
          deps: fakeCritiqueDeps,
        }),
      (err: unknown) => err instanceof ApiError && err.code === "not_found"
    );
  });
});
