// End-to-end-ish smoke harness for the /api/v1 agent surface (PR6).
//
// What runs today: the job lifecycle, idempotency, the revision worker (wired
// to the real applyPatches with a mock editorial agent), the export duration
// policy, and local-mode actor resolution.
//
// The three full prompt->MP4 flows from the scope doc's PR6 acceptance criteria
// are declared as test.todo below. They cannot pass until PR1–PR5 land
// (project/asset/composition/generation/audio-alignment surfaces), which is the
// expected state for this scaffolding PR.

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentApiStore } from "../jobs";
import { ApiError, resolveActor } from "../runtime";
import { resolveExportDuration, runExportJob, runRevisionJob } from "../workers";
import { Patch, Project } from "../../types";

async function tempStore(): Promise<AgentApiStore> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "popcornready-jobs-"));
  return new AgentApiStore(dir);
}

function projectFixture(): Project {
  return {
    id: "default",
    goal: "demo",
    plan: null,
    timeline: {
      aspectRatio: "9:16",
      fps: 30,
      segments: [
        { id: "seg_1", clipId: "clip_a", sourceInSec: 0, sourceOutSec: 3, role: "hook", reason: "" },
        { id: "seg_2", clipId: "clip_b", sourceInSec: 0, sourceOutSec: 2, role: "payoff", reason: "" },
      ],
    },
    clips: [
      { id: "clip_a", filename: "a.mp4", url: "/uploads/a.mp4", kind: "video", durationSec: 10, description: "" },
      { id: "clip_b", filename: "b.mp4", url: "/uploads/b.mp4", kind: "video", durationSec: 10, description: "" },
      { id: "clip_audio", filename: "n.mp3", url: "/uploads/n.mp3", kind: "audio", durationSec: 12, description: "" },
    ],
    critic: null,
    chat: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("job lifecycle: queued -> running -> succeeded", async () => {
  const store = await tempStore();
  const { job, created } = await store.createOrGetJob({
    type: "revision",
    projectId: "proj_1",
  });
  assert.equal(created, true);
  assert.equal(job.status, "queued");

  await store.setStep(job.id, "planning_timeline");
  const finished = await store.succeed(job.id, { ok: true });
  assert.equal(finished.status, "succeeded");
  assert.deepEqual(finished.result, { ok: true });

  const reloaded = await store.getJob(job.id);
  assert.equal(reloaded?.status, "succeeded");
});

test("idempotency: same key + type returns the same job", async () => {
  const store = await tempStore();
  const first = await store.createOrGetJob({
    type: "export",
    projectId: "proj_1",
    idempotencyKey: "export-001",
  });
  const second = await store.createOrGetJob({
    type: "export",
    projectId: "proj_1",
    idempotencyKey: "export-001",
  });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.job.id, second.job.id);
});

test("revision worker produces a sibling timeline without mutating the base", async () => {
  const project = projectFixture();
  const patches: Patch[] = [
    { op: "set_caption", segmentId: "seg_1", caption: "Hello", reason: "" },
  ];
  const mockRevise = async () => ({ summary: "Added a caption.", patches });

  const result = await runRevisionJob({
    project,
    timelineId: "tl_requested",
    message: "Add a caption to the hook.",
    deps: { revise: mockRevise as any },
  });

  assert.equal(result.appliedPatches, 1);
  assert.equal(result.summary, "Added a caption.");
  assert.equal(result.timeline.segments[0].caption, "Hello");
  // Base timeline is untouched — the revision is a sibling cut.
  assert.equal(project.timeline?.segments[0].caption, undefined);
});

test("revision worker rejects a project with no timeline", async () => {
  const project = projectFixture();
  project.timeline = null;
  await assert.rejects(
    () =>
      runRevisionJob({
        project,
        timelineId: "tl_requested",
        message: "tighten the intro",
        deps: { revise: (async () => ({ summary: "", patches: [] })) as any },
      }),
    (err: unknown) => err instanceof ApiError && err.code === "timeline_not_ready"
  );
});

test("resolveExportDuration honors each duration policy", () => {
  // timeline=5s, audio=12s.
  assert.equal(
    resolveExportDuration({ timelineDurationSec: 5, audioDurationSec: 12, policy: "timeline_only" }).durationSec,
    5
  );
  assert.equal(
    resolveExportDuration({ timelineDurationSec: 5, audioDurationSec: 12, policy: "match_longest_media" }).durationSec,
    12
  );
  const failPlan = resolveExportDuration({
    timelineDurationSec: 5,
    audioDurationSec: 12,
    policy: "fail_on_mismatch",
  });
  assert.equal(failPlan.mismatch, true);
  assert.equal(failPlan.durationSec, 5);
});

test("export worker emits a pending_render artifact under match_longest_media", () => {
  const project = projectFixture();
  const { artifact } = runExportJob({
    project,
    timelineId: "tl_requested",
    options: { audioAssetIds: ["clip_audio"], durationPolicy: "match_longest_media" },
  });
  assert.equal(artifact.status, "pending_render");
  assert.equal(artifact.url, null);
  assert.equal(artifact.durationSec, 12);
  assert.equal(artifact.renderPlan.audioDurationSec, 12);
});

test("export worker fails on audio/timeline mismatch when policy is fail_on_mismatch", () => {
  const project = projectFixture();
  assert.throws(
    () =>
      runExportJob({
        project,
        timelineId: "tl_requested",
        options: { audioAssetIds: ["clip_audio"], durationPolicy: "fail_on_mismatch" },
      }),
    (err: unknown) => err instanceof ApiError && err.code === "audio_timeline_mismatch"
  );
});

test("export worker rejects an unknown duration policy", () => {
  const project = projectFixture();
  // Simulates a misspelled policy arriving as raw JSON (bypassing the type).
  assert.throws(
    () =>
      runExportJob({
        project,
        timelineId: "tl_requested",
        options: { durationPolicy: "fail_on_mismtach" as any },
      }),
    (err: unknown) =>
      err instanceof ApiError && err.code === "unsupported_duration_policy"
  );
});

test("export worker rejects a non-audio asset", () => {
  const project = projectFixture();
  assert.throws(
    () =>
      runExportJob({
        project,
        timelineId: "tl_requested",
        options: { audioAssetIds: ["clip_a"] },
      }),
    (err: unknown) => err instanceof ApiError && err.code === "invalid_request"
  );
});

test("local-mode actor resolution; hosted mode is not implemented yet", () => {
  const actor = resolveActor({ authMode: "local" });
  assert.equal(actor.mode, "local");
  assert.ok(actor.workspaceId);

  assert.throws(
    () => resolveActor({ authMode: "hosted", apiKey: "sk_whatever" }),
    (err: unknown) => err instanceof ApiError && err.status === 501
  );
});

// --- Full PR6 acceptance flows: blocked on PR1–PR5 -------------------------
// These exercise the create -> ... -> MP4 loop a real external agent would run.
// Kept as todo so the suite documents the target without failing.
test.todo(
  "asset-driven project to MP4 (needs PR1 project/asset surface + PR5 render)"
);
test.todo(
  "prompt-only project to MP4 (needs PR3 composition + PR4 generation + PR5 render)"
);
test.todo(
  "hybrid project to MP4 (needs PR1–PR5: provided + generated assets, render)"
);
