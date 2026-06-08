import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { AuthContext } from "../auth";
import { ApiError } from "../errors";
import type { ApiResult } from "../generated-assets";
import type { V1Asset } from "../store";
import {
  generateBeatClip,
  generateBeatKeyframe,
  setBeatMediaDepsForTests,
} from "../beats";

const LOCAL_WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";

const auth: AuthContext = {
  mode: "local",
  actor: { id: "local_dev", type: "local" },
  workspaceId: LOCAL_WORKSPACE_ID,
  isLocal: true,
};

function jobResult(assetId: string): ApiResult {
  return {
    status: 202,
    body: {
      job: {
        id: "job_1",
        type: "asset_generation",
        status: "succeeded",
        result: { assetIds: [assetId] },
      },
    },
  };
}

afterEach(() => setBeatMediaDepsForTests(null));

test("keyframe: forwards an image request and records beatId/anchorIds provenance", async () => {
  const generatorBodies: unknown[] = [];
  // Stand-in for the pooled asset whose provenance the wrapper stamps.
  const asset = {
    id: "asset_kf",
    provenance: { provider: "mock", prompt: "from prompt" },
  } as unknown as V1Asset;
  let updated: V1Asset | undefined;

  setBeatMediaDepsForTests({
    createGeneratedAsset: async ({ body }) => {
      generatorBodies.push(body);
      return jobResult("asset_kf");
    },
    updateAsset: async (_ws, _proj, _id, updater) => {
      updater(asset);
      updated = asset;
      return asset;
    },
  });

  const res = await generateBeatKeyframe({
    auth,
    projectId: "proj_1",
    beatId: "hook",
    body: { prompt: "petri dish hook", anchorIds: ["anchor_hero"], provider: "mock" },
  });

  assert.equal(res.status, 202);

  // The wrapper narrows to an image and threads anchors as reference conditioning.
  const sent = generatorBodies[0] as Record<string, unknown>;
  assert.equal(sent.kind, "image");
  assert.equal(sent.prompt, "petri dish hook");
  assert.equal(sent.provider, "mock");
  assert.deepEqual(sent.referenceAssetIds, ["anchor_hero"]);

  // Provenance is stamped onto the produced asset.
  assert.ok(updated);
  assert.equal(updated!.provenance!.beatId, "hook");
  assert.deepEqual(updated!.provenance!.anchorIds, ["anchor_hero"]);
});

test("clip: narrows to a video request", async () => {
  const generatorBodies: unknown[] = [];
  setBeatMediaDepsForTests({
    createGeneratedAsset: async ({ body }) => {
      generatorBodies.push(body);
      return jobResult("asset_clip");
    },
    updateAsset: async (_ws, _proj, _id, updater) => {
      const asset = { provenance: { provider: "mock", prompt: "x" } } as unknown as V1Asset;
      updater(asset);
      return asset;
    },
  });

  await generateBeatClip({
    auth,
    projectId: "proj_1",
    beatId: "turn",
    body: { prompt: "the turn", provider: "mock" },
  });

  assert.equal((generatorBodies[0] as Record<string, unknown>).kind, "video");
});

test("derives the prompt from a composition beat's intent", async () => {
  const generatorBodies: unknown[] = [];
  setBeatMediaDepsForTests({
    getCompositionPlan: async () =>
      ({
        plannedBeats: [
          { name: "hook", intent: "open on a curious petri dish", durationSec: 4 },
        ],
      }) as never,
    createGeneratedAsset: async ({ body }) => {
      generatorBodies.push(body);
      return jobResult("asset_kf");
    },
    updateAsset: async (_ws, _proj, _id, updater) => {
      const asset = { provenance: { provider: "mock", prompt: "x" } } as unknown as V1Asset;
      updater(asset);
      return asset;
    },
  });

  await generateBeatKeyframe({
    auth,
    projectId: "proj_1",
    beatId: "hook",
    body: { compositionId: "comp_1" },
  });

  assert.equal(
    (generatorBodies[0] as Record<string, unknown>).prompt,
    "open on a curious petri dish"
  );
});

test("precondition: missing prompt with nothing to derive from throws a typed error", async () => {
  let generatorCalled = false;
  setBeatMediaDepsForTests({
    createGeneratedAsset: async () => {
      generatorCalled = true;
      return jobResult("asset_kf");
    },
  });

  await assert.rejects(
    generateBeatKeyframe({
      auth,
      projectId: "proj_1",
      beatId: "hook",
      body: { anchorIds: ["anchor_hero"] },
    }),
    (err: unknown) => {
      assert.ok(err instanceof ApiError, `expected ApiError, got ${err}`);
      assert.equal(err.code, "validation_failed");
      // Names exactly which inputs would satisfy the precondition (self-heal).
      const fields = (err.details?.fields ?? []) as Array<{ path: string; message: string }>;
      assert.ok(fields.some((f) => f.path === "prompt" && /compositionId/.test(f.message)));
      return true;
    }
  );

  // Strict precondition: never reach the (expensive) generator when unsatisfied.
  assert.equal(generatorCalled, false);
});

test("autocreate opts into deriving a prompt from the beat id", async () => {
  const generatorBodies: unknown[] = [];
  setBeatMediaDepsForTests({
    createGeneratedAsset: async ({ body }) => {
      generatorBodies.push(body);
      return jobResult("asset_kf");
    },
    updateAsset: async (_ws, _proj, _id, updater) => {
      const asset = { provenance: { provider: "mock", prompt: "x" } } as unknown as V1Asset;
      updater(asset);
      return asset;
    },
  });

  await generateBeatKeyframe({
    auth,
    projectId: "proj_1",
    beatId: "hook",
    body: { autocreate: true },
  });

  const prompt = String((generatorBodies[0] as Record<string, unknown>).prompt);
  assert.ok(prompt.includes("hook"));
});
