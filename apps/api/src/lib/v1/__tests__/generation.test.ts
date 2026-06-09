import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Keep the v1 logger quiet so node:test output is not interleaved with the
// structured JSON lines runGenerationJob emits on every step transition.
const previousLogLevel = process.env.POPCORN_READY_LOG_LEVEL;
test.before(() => {
  process.env.POPCORN_READY_LOG_LEVEL = "silent";
});

test.after(() => {
  if (previousLogLevel === undefined) {
    delete process.env.POPCORN_READY_LOG_LEVEL;
  } else {
    process.env.POPCORN_READY_LOG_LEVEL = previousLogLevel;
  }
});

import { resolveActor } from "../actor";
import { compileEditGraphToTimeline } from "@popcorn/shared/edit-graph";
import { ApiError } from "../errors";
import { planBeats, singleSceneFromBeats } from "@popcorn/shared/types";
import {
  GenerationDeps,
  createGenerationJob,
  runGenerationJob,
} from "../generation";
import { noopProgressEmitter } from "../generation-progress";
import { V1Store, createStore } from "../store";
import {
  AspectRatio,
  BriefVersion,
  CompositionPlan,
  SCHEMA,
  V1Asset,
  V1Project,
  VideoBriefInput,
} from "@popcorn/shared/v1/types";

// Deterministic, offline stand-ins for the model-backed agent calls. They
// produce one segment per visual clip so we exercise the full
// resolve -> plan -> select -> critique -> persist path without the network.
const fakeDeps: GenerationDeps = {
  async planEdit(input) {
    return {
      targetLengthSec: input.targetLengthSec,
      style: input.style,
      aspectRatio: input.aspectRatio as AspectRatio,
      scenes: singleSceneFromBeats([
        { id: "beat_1_hook", name: "hook", durationSec: 3, intent: "grab attention" },
      ]),
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
  async generateStoryboardTiles({ projectId, plan }) {
    return planBeats(plan).map((beat) => ({
      id: `tile_${beat.id ?? beat.name}`,
      schemaVersion: "asset.v1" as const,
      projectId,
      kind: "image" as const,
      role: "beat_storyboard" as const,
      depicts: { beatId: beat.id ?? beat.name },
      media: {
        url: `/generated/tile_${beat.id ?? beat.name}.png`,
        filename: `tile_${beat.id ?? beat.name}.png`,
        durationSec: beat.durationSec,
      },
      source: "generated" as const,
      provenance: {
        provider: "mock",
        prompt: `sketch: ${beat.intent}`,
        inputs: { beatId: beat.id ?? beat.name },
      },
    }));
  },
};

async function withStore(fn: (store: V1Store) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "popcornready-v1-"));
  try {
    await fn(createStore(dir));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const NOW = "2026-05-28T12:00:00.000Z";

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

async function seedComposition(
  store: V1Store,
  projectId: string,
  briefVersionId: string,
  overrides: Partial<CompositionPlan> = {}
): Promise<CompositionPlan> {
  return store.saveComposition({
    id: "comp_test",
    schemaVersion: SCHEMA.composition,
    projectId,
    briefVersionId,
    mode: "prompt_only",
    status: "ready_for_timeline",
    plannedBeats: [],
    generatedAssetJobIds: [],
    readyAssetIds: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

test("asset-driven generation produces a timeline with provenance", async () => {
  await withStore(async (store) => {
    const project = await seedProject(store);
    const brief = await seedBrief(store, project.id);
    await seedAsset(store, project.id, { id: "asset_1" });
    await seedAsset(store, project.id, { id: "asset_2" });
    await seedAsset(store, project.id, { id: "asset_3" });

    const job = await createGenerationJob({
      store,
      actor: resolveActor(),
      projectId: project.id,
      body: { briefVersionId: brief.id, assetIds: ["asset_1", "asset_2", "asset_3"] },
    });

    assert.equal(job.type, "generation");
    assert.equal(job.status, "queued");
    assert.deepEqual(job.input?.assetIds, ["asset_1", "asset_2", "asset_3"]);

    const done = await runGenerationJob(store, job.id, fakeDeps);
    assert.equal(done.status, "succeeded");
    assert.equal(done.result?.timelineIds.length, 1);

    const timelineId = done.result!.timelineIds[0];
    const timeline = await store.getTimeline(timelineId);
    assert.ok(timeline, "timeline should be persisted");
    assert.equal(timeline!.segments.length, 3);
    assert.equal(timeline!.briefVersionId, brief.id);
    assert.deepEqual(timeline!.provenance.sourceAssetIds, [
      "asset_1",
      "asset_2",
      "asset_3",
    ]);
    assert.ok(timeline!.provenance.criticReport, "critic report stored");
    assert.equal(timeline!.createdBy.jobId, job.id);
  });
});

test("generation passes review feedback to creative planning and clears it after use", async () => {
  await withStore(async (store) => {
    const project = await seedProject(store);
    const brief = await seedBrief(store, project.id);
    await seedAsset(store, project.id, { id: "asset_feedback" });

    const job = await createGenerationJob({
      store,
      actor: resolveActor(),
      projectId: project.id,
      body: { briefVersionId: brief.id, assetIds: ["asset_feedback"] },
    });

    let seenFeedback: string | null | undefined;
    let cleared = false;
    const deps: GenerationDeps = {
      ...fakeDeps,
      async planEdit(input) {
        seenFeedback = input.feedback;
        return fakeDeps.planEdit(input);
      },
    };
    const progress = {
      ...noopProgressEmitter,
      async getReviewFeedback() {
        return "make the hook about the surprise";
      },
      async clearReviewFeedback() {
        cleared = true;
      },
    };

    const done = await runGenerationJob(store, job.id, deps, progress);

    assert.equal(done.status, "succeeded");
    assert.equal(seenFeedback, "make the hook about the surprise");
    assert.equal(cleared, true);
  });
});

test("generation persists edit graph as source and serves a derived timeline", async () => {
  await withStore(async (store) => {
    const project = await seedProject(store);
    const brief = await seedBrief(store, project.id, {
      audience: "busy founders",
      style: "direct",
    });
    await seedAsset(store, project.id, { id: "asset_1" });
    await seedAsset(store, project.id, { id: "asset_2" });

    const job = await createGenerationJob({
      store,
      actor: resolveActor(),
      projectId: project.id,
      body: {
        briefVersionId: brief.id,
        assetIds: ["asset_1", "asset_2"],
        showCaptions: true,
      },
    });
    const done = await runGenerationJob(store, job.id, fakeDeps);

    const timeline = await store.getTimeline(done.result!.timelineIds[0]);
    assert.ok(timeline, "timeline should still be readable");
    assert.equal(timeline!.derivedFrom?.compilerVersion, "edit-graph-compiler.v1");
    assert.equal(timeline!.derivedFrom?.editGraphId, done.result!.editGraphIds![0]);

    const graph = await store.getEditGraph(timeline!.derivedFrom!.editGraphId);
    assert.ok(graph, "edit graph should be persisted");
    assert.equal(graph!.schemaVersion, "editGraph.v1");
    assert.equal(graph!.projectId, project.id);
    assert.equal(graph!.briefVersionId, brief.id);
    assert.equal(graph!.intent.goal, brief.brief.goal);
    assert.equal(graph!.intent.audience, "busy founders");
    assert.equal(graph!.timeline?.id, timeline!.id);
    assert.equal(graph!.timeline?.derived, true);
    assert.equal(graph!.createdBy.jobId, job.id);
    assert.deepEqual(
      graph!.edit.decisions.map((decision) => decision.timelineSegmentId),
      timeline!.segments.map((segment) => segment.id)
    );

    const recompiled = compileEditGraphToTimeline(graph!);
    assert.deepEqual(recompiled, {
      aspectRatio: timeline!.aspectRatio,
      fps: timeline!.fps,
      showCaptions: timeline!.showCaptions,
      segments: timeline!.segments,
    });
  });
});

test("prompt-only composition generation produces a timeline", async () => {
  await withStore(async (store) => {
    const project = await seedProject(store);
    const brief = await seedBrief(store, project.id);
    await seedAsset(store, project.id, {
      id: "asset_gen_1",
      kind: "image",
      source: "generated",
      generatedAssetJobId: "job_img_1",
    });
    await seedAsset(store, project.id, {
      id: "asset_gen_2",
      kind: "image",
      source: "generated",
      generatedAssetJobId: "job_img_2",
    });
    const composition = await seedComposition(store, project.id, brief.id, {
      readyAssetIds: ["asset_gen_1", "asset_gen_2"],
      generatedAssetJobIds: ["job_img_1", "job_img_2"],
    });

    const job = await createGenerationJob({
      store,
      actor: resolveActor(),
      projectId: project.id,
      body: { briefVersionId: brief.id, assetIds: [], compositionId: composition.id },
    });

    assert.deepEqual(job.input?.assetIds, ["asset_gen_1", "asset_gen_2"]);
    assert.equal(job.input?.compositionId, composition.id);

    const done = await runGenerationJob(store, job.id, fakeDeps);
    assert.equal(done.status, "succeeded");

    const timeline = await store.getTimeline(done.result!.timelineIds[0]);
    assert.ok(timeline);
    assert.equal(timeline!.compositionId, composition.id);
    assert.equal(timeline!.segments.length, 2);
    assert.deepEqual(timeline!.provenance.generatedAssetJobIds.sort(), [
      "job_img_1",
      "job_img_2",
    ]);
  });
});

test("hybrid gap fill requires an explicit user choice", async () => {
  await withStore(async (store) => {
    const project = await seedProject(store);
    const brief = await seedBrief(store, project.id);
    await seedAsset(store, project.id, { id: "asset_upload_1" });
    await seedAsset(store, project.id, {
      id: "asset_gen_1",
      kind: "image",
      source: "generated",
      generatedAssetJobId: "job_img_1",
    });
    const composition = await seedComposition(store, project.id, brief.id, {
      mode: "hybrid",
      plannedBeats: [
        {
          name: "hook",
          intent: "use the supplied footage",
          durationSec: 3,
          assetStrategy: "use_existing",
          requiredAssetIds: ["asset_upload_1"],
        },
        {
          name: "proof",
          intent: "show a missing product detail",
          durationSec: 3,
          assetStrategy: "generate_image",
          generatedAssetJobIds: ["job_img_1"],
        },
      ],
      readyAssetIds: ["asset_gen_1"],
      generatedAssetJobIds: ["job_img_1"],
    });

    await assert.rejects(
      () =>
        createGenerationJob({
          store,
          actor: resolveActor(),
          projectId: project.id,
          body: {
            briefVersionId: brief.id,
            assetIds: ["asset_upload_1"],
            compositionId: composition.id,
            mode: "hybrid",
          },
        }),
      (err) =>
        err instanceof ApiError &&
        err.code === "validation_failed" &&
        /allowGeneratedGapFill/.test(err.message)
    );
  });
});

test("hybrid gap fill merges ready generated assets into timeline input", async () => {
  await withStore(async (store) => {
    const project = await seedProject(store);
    const brief = await seedBrief(store, project.id);
    await seedAsset(store, project.id, { id: "asset_upload_1" });
    await seedAsset(store, project.id, {
      id: "asset_gen_1",
      kind: "image",
      source: "generated",
      generatedAssetJobId: "job_img_1",
    });
    const composition = await seedComposition(store, project.id, brief.id, {
      mode: "hybrid",
      plannedBeats: [
        {
          name: "hook",
          intent: "use the supplied footage",
          durationSec: 3,
          assetStrategy: "use_existing",
          requiredAssetIds: ["asset_upload_1"],
        },
        {
          name: "proof",
          intent: "show a generated cutaway",
          durationSec: 3,
          assetStrategy: "generate_image",
          generatedAssetJobIds: ["job_img_1"],
        },
      ],
      readyAssetIds: ["asset_gen_1"],
      generatedAssetJobIds: ["job_img_1"],
    });

    const job = await createGenerationJob({
      store,
      actor: resolveActor(),
      projectId: project.id,
      body: {
        briefVersionId: brief.id,
        assetIds: ["asset_upload_1"],
        compositionId: composition.id,
        mode: "hybrid",
        allowGeneratedGapFill: true,
      },
    });

    assert.deepEqual(job.input?.assetIds, ["asset_upload_1", "asset_gen_1"]);
    assert.equal(job.input?.allowGeneratedGapFill, true);

    const done = await runGenerationJob(store, job.id, fakeDeps);
    assert.equal(done.status, "succeeded");

    const timeline = await store.getTimeline(done.result!.timelineIds[0]);
    assert.ok(timeline);
    assert.equal(timeline!.segments.length, 2);
    assert.deepEqual(timeline!.provenance.generatedAssetJobIds, ["job_img_1"]);
  });
});

test("hybrid uploaded-only choice leaves generated gap-fill assets out", async () => {
  await withStore(async (store) => {
    const project = await seedProject(store);
    const brief = await seedBrief(store, project.id);
    await seedAsset(store, project.id, { id: "asset_upload_1" });
    await seedAsset(store, project.id, {
      id: "asset_gen_1",
      kind: "image",
      source: "generated",
      generatedAssetJobId: "job_img_1",
    });
    const composition = await seedComposition(store, project.id, brief.id, {
      mode: "hybrid",
      plannedBeats: [
        {
          name: "proof",
          intent: "show a generated cutaway",
          durationSec: 3,
          assetStrategy: "generate_image",
          generatedAssetJobIds: ["job_img_1"],
        },
      ],
      readyAssetIds: ["asset_gen_1"],
      generatedAssetJobIds: ["job_img_1"],
    });

    const job = await createGenerationJob({
      store,
      actor: resolveActor(),
      projectId: project.id,
      body: {
        briefVersionId: brief.id,
        assetIds: ["asset_upload_1"],
        compositionId: composition.id,
        mode: "hybrid",
        allowGeneratedGapFill: false,
      },
    });

    assert.deepEqual(job.input?.assetIds, ["asset_upload_1"]);
    assert.equal(job.input?.allowGeneratedGapFill, false);

    const done = await runGenerationJob(store, job.id, fakeDeps);
    const timeline = await store.getTimeline(done.result!.timelineIds[0]);
    assert.ok(timeline);
    assert.deepEqual(
      timeline!.segments.map((segment) => segment.clipId),
      ["asset_upload_1"]
    );
  });
});

test("empty hybrid gap-fill requests still require an explicit user choice", async () => {
  await withStore(async (store) => {
    const project = await seedProject(store);
    const brief = await seedBrief(store, project.id);
    await seedAsset(store, project.id, {
      id: "asset_gen_1",
      kind: "image",
      source: "generated",
      generatedAssetJobId: "job_img_1",
    });
    const composition = await seedComposition(store, project.id, brief.id, {
      mode: "hybrid",
      plannedBeats: [
        {
          name: "proof",
          intent: "show a generated cutaway",
          durationSec: 3,
          assetStrategy: "generate_image",
          generatedAssetJobIds: ["job_img_1"],
        },
      ],
      readyAssetIds: ["asset_gen_1"],
      generatedAssetJobIds: ["job_img_1"],
    });

    for (const assetIds of [undefined, [] as string[]]) {
      await assert.rejects(
        () =>
          createGenerationJob({
            store,
            actor: resolveActor(),
            projectId: project.id,
            body: {
              briefVersionId: brief.id,
              ...(assetIds === undefined ? {} : { assetIds }),
              compositionId: composition.id,
              mode: "hybrid",
            },
          }),
        (err) =>
          err instanceof ApiError &&
          err.code === "validation_failed" &&
          /allowGeneratedGapFill/.test(err.message)
      );
    }
  });
});

test("empty hybrid uploaded-only choice asks for uploaded assets", async () => {
  await withStore(async (store) => {
    const project = await seedProject(store);
    const brief = await seedBrief(store, project.id);
    await seedAsset(store, project.id, {
      id: "asset_gen_1",
      kind: "image",
      source: "generated",
      generatedAssetJobId: "job_img_1",
    });
    const composition = await seedComposition(store, project.id, brief.id, {
      mode: "hybrid",
      plannedBeats: [
        {
          name: "proof",
          intent: "show a generated cutaway",
          durationSec: 3,
          assetStrategy: "generate_image",
          generatedAssetJobIds: ["job_img_1"],
        },
      ],
      readyAssetIds: ["asset_gen_1"],
      generatedAssetJobIds: ["job_img_1"],
    });

    await assert.rejects(
      () =>
        createGenerationJob({
          store,
          actor: resolveActor(),
          projectId: project.id,
          body: {
            briefVersionId: brief.id,
            assetIds: [],
            compositionId: composition.id,
            mode: "hybrid",
            allowGeneratedGapFill: false,
          },
        }),
      (err) =>
        err instanceof ApiError &&
        err.code === "validation_failed" &&
        /assetIds is required/.test(err.message)
    );
  });
});

test("assets must be ready before selection", async () => {
  await withStore(async (store) => {
    const project = await seedProject(store);
    const brief = await seedBrief(store, project.id);
    await seedAsset(store, project.id, { id: "asset_pending", status: "processing" });

    await assert.rejects(
      () =>
        createGenerationJob({
          store,
          actor: resolveActor(),
          projectId: project.id,
          body: { briefVersionId: brief.id, assetIds: ["asset_pending"] },
        }),
      (err) => err instanceof ApiError && err.code === "asset_not_ready"
    );
  });
});

test("missing briefVersionId is rejected", async () => {
  await withStore(async (store) => {
    const project = await seedProject(store);
    await seedAsset(store, project.id, { id: "asset_1" });

    await assert.rejects(
      () =>
        createGenerationJob({
          store,
          actor: resolveActor(),
          projectId: project.id,
          body: { assetIds: ["asset_1"] },
        }),
      (err) => err instanceof ApiError && err.code === "brief_missing"
    );
  });
});

test("generation rejects projects outside the actor workspace", async () => {
  await withStore(async (store) => {
    const project = await seedProject(store);
    const brief = await seedBrief(store, project.id);
    await seedAsset(store, project.id, { id: "asset_1" });

    await assert.rejects(
      () =>
        createGenerationJob({
          store,
          actor: { ...resolveActor(), workspaceId: "other_workspace" },
          projectId: project.id,
          body: { briefVersionId: brief.id, assetIds: ["asset_1"] },
        }),
      (err) => err instanceof ApiError && err.code === "not_found"
    );
  });
});

test("empty assets without a composition is rejected", async () => {
  await withStore(async (store) => {
    const project = await seedProject(store);
    const brief = await seedBrief(store, project.id);

    await assert.rejects(
      () =>
        createGenerationJob({
          store,
          actor: resolveActor(),
          projectId: project.id,
          body: { briefVersionId: brief.id, assetIds: [] },
        }),
      (err) => err instanceof ApiError && err.code === "validation_failed"
    );
  });
});

test("composition planned for a different brief version is rejected", async () => {
  await withStore(async (store) => {
    const project = await seedProject(store);
    const brief = await seedBrief(store, project.id); // briefv_test
    await seedAsset(store, project.id, { id: "asset_gen_1", kind: "image" });
    const composition = await seedComposition(store, project.id, "briefv_other", {
      readyAssetIds: ["asset_gen_1"],
    });

    await assert.rejects(
      () =>
        createGenerationJob({
          store,
          actor: resolveActor(),
          projectId: project.id,
          body: { briefVersionId: brief.id, assetIds: [], compositionId: composition.id },
        }),
      (err) => err instanceof ApiError && err.code === "validation_failed"
    );
  });
});

test("idempotent retry replays the original job even if asset state changed", async () => {
  await withStore(async (store) => {
    const project = await seedProject(store);
    const brief = await seedBrief(store, project.id);
    await seedAsset(store, project.id, { id: "asset_1" });
    const actor = resolveActor();

    const first = await createGenerationJob({
      store,
      actor,
      projectId: project.id,
      body: { briefVersionId: brief.id, assetIds: ["asset_1"] },
      idempotencyKey: "retry-key",
    });

    // Upstream state changes between the original request and the retry.
    await seedAsset(store, project.id, { id: "asset_1", status: "failed" });

    const retry = await createGenerationJob({
      store,
      actor,
      projectId: project.id,
      body: { briefVersionId: brief.id, assetIds: ["asset_1"] },
      idempotencyKey: "retry-key",
    });
    assert.equal(retry.id, first.id, "retry replays the original job, not asset_not_ready");
  });
});

test("job persists requestId for correlation, and tracks stepStartedAt", async () => {
  await withStore(async (store) => {
    const project = await seedProject(store);
    const brief = await seedBrief(store, project.id);
    await seedAsset(store, project.id, { id: "asset_1" });

    const job = await createGenerationJob({
      store,
      actor: resolveActor(),
      projectId: project.id,
      body: { briefVersionId: brief.id, assetIds: ["asset_1"] },
      requestId: "req_observe_1",
    });

    assert.equal(job.requestId, "req_observe_1");
    assert.equal(job.progress.currentStep, "validating_request");
    assert.ok(job.progress.stepStartedAt, "stepStartedAt is set on creation");

    const done = await runGenerationJob(store, job.id, fakeDeps);
    assert.equal(done.status, "succeeded");
    assert.equal(done.requestId, "req_observe_1");
    assert.ok(done.progress.stepStartedAt, "stepStartedAt is preserved after run");

    // The persisted job (loaded fresh) must keep the correlation ID so a poll
    // after server restart still ties back to the originating request.
    const reloaded = await store.getJob(job.id);
    assert.equal(reloaded?.requestId, "req_observe_1");
  });
});

test("provider errors are redacted before being persisted on the job", async () => {
  await withStore(async (store) => {
    const project = await seedProject(store);
    const brief = await seedBrief(store, project.id);
    await seedAsset(store, project.id, { id: "asset_1" });

    const leakyDeps: GenerationDeps = {
      ...fakeDeps,
      async planEdit() {
        throw new Error(
          "OpenAI request failed (401): invalid Bearer sk-AbCdEfGhIjKlMnOpQrStUv12345678 token leaked"
        );
      },
    };

    const job = await createGenerationJob({
      store,
      actor: resolveActor(),
      projectId: project.id,
      body: { briefVersionId: brief.id, assetIds: ["asset_1"] },
      requestId: "req_redact_1",
    });

    const done = await runGenerationJob(store, job.id, leakyDeps);
    assert.equal(done.status, "failed");
    assert.ok(done.error, "job.error is populated");
    assert.doesNotMatch(
      done.error!.message,
      /sk-AbCdEfGh/,
      "secret-like token must not appear in persisted job error"
    );
    assert.match(done.error!.message, /\[REDACTED\]/);
  });
});

test("idempotent replay returns the same job; conflicting body conflicts", async () => {
  await withStore(async (store) => {
    const project = await seedProject(store);
    const brief = await seedBrief(store, project.id);
    await seedAsset(store, project.id, { id: "asset_1" });
    await seedAsset(store, project.id, { id: "asset_2" });
    const actor = resolveActor();

    const first = await createGenerationJob({
      store,
      actor,
      projectId: project.id,
      body: { briefVersionId: brief.id, assetIds: ["asset_1"] },
      idempotencyKey: "key-123",
    });

    const replay = await createGenerationJob({
      store,
      actor,
      projectId: project.id,
      body: { briefVersionId: brief.id, assetIds: ["asset_1"] },
      idempotencyKey: "key-123",
    });
    assert.equal(replay.id, first.id, "same key + body replays the original job");

    await assert.rejects(
      () =>
        createGenerationJob({
          store,
          actor,
          projectId: project.id,
          body: { briefVersionId: brief.id, assetIds: ["asset_1", "asset_2"] },
          idempotencyKey: "key-123",
        }),
      (err) => err instanceof ApiError && err.code === "idempotency_conflict"
    );
  });
});
