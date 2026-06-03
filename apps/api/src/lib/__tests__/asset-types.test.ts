import assert from "node:assert/strict";
import test from "node:test";
import { Clip } from "@popcorn/shared/types";
import {
  Asset,
  assetToClip,
  clipToAsset,
  defaultRoleForKind,
} from "@popcorn/shared/assets/types";

const generatedClip: Clip = {
  id: "vid_1",
  filename: "vid_1.mp4",
  url: "/generated/vid_1.mp4",
  kind: "video",
  durationSec: 4,
  measuredDurationSec: 3.9,
  description: "hook: open on the strongest moment",
  source: "generated",
  generatedBy: {
    provider: "gemini",
    model: "veo-3.1-generate-preview",
    prompt: "a cinematic hook shot",
    costUsd: 2,
    characterBinding: {
      assetId: "vid_1",
      characterProfileIds: ["char_1"],
      referenceIds: ["ref_1"],
      consistencyMode: "hero_frame",
      originalPrompt: "the boy",
      promptInvariantVersion: "v1",
    },
  },
  characterBinding: {
    assetId: "vid_1",
    characterProfileIds: ["char_1"],
    referenceIds: ["ref_1"],
    consistencyMode: "hero_frame",
    originalPrompt: "the boy",
    promptInvariantVersion: "v1",
  },
};

const uploadClip: Clip = {
  id: "up_1",
  filename: "up_1.mp4",
  url: "/uploads/up_1.mp4",
  kind: "video",
  durationSec: 6,
  description: "user upload",
  source: "upload",
};

test("clip -> asset -> clip is lossless for a generated clip", () => {
  const asset = clipToAsset(generatedClip, {
    projectId: "default",
    role: "beat_clip",
    depicts: { beatId: "beat_1_hook" },
  });
  assert.equal(asset.projectId, "default");
  assert.equal(asset.role, "beat_clip");
  assert.equal(asset.kind, "video");
  assert.deepEqual(asset.depicts, { beatId: "beat_1_hook" });
  assert.equal(asset.media.url, "/generated/vid_1.mp4");
  assert.equal(asset.media.measuredDurationSec, 3.9);

  // Round-trip back to the runtime Clip shape, by value.
  assert.deepEqual(assetToClip(asset), generatedClip);
});

test("clip -> asset -> clip is lossless for an upload clip", () => {
  const asset = clipToAsset(uploadClip, { projectId: "default" });
  assert.equal(asset.role, "beat_clip"); // default for video
  assert.equal(asset.source, "upload");
  assert.equal(asset.provenance, undefined);
  assert.deepEqual(assetToClip(asset), uploadClip);
});

test("defaultRoleForKind maps by media kind", () => {
  assert.equal(defaultRoleForKind("audio"), "soundtrack");
  assert.equal(defaultRoleForKind("image"), "scene_anchor");
  assert.equal(defaultRoleForKind("video"), "beat_clip");
});

test("asset -> clip drops asset-only fields (role/projectId/depicts not on Clip)", () => {
  const asset: Asset = {
    id: "img_1",
    schemaVersion: "asset.v1",
    projectId: "default",
    kind: "image",
    role: "character_anchor",
    depicts: { characterId: "char_1" },
    description: "hero reference",
    media: { url: "/generated/img_1.png", filename: "img_1.png", durationSec: 4 },
    source: "generated",
    characterInvariants: { identity: "same boy" },
  };
  const clip = assetToClip(asset);
  assert.equal(clip.id, "img_1");
  assert.equal(clip.kind, "image");
  assert.equal(clip.description, "hero reference");
  assert.ok(!("role" in clip));
  assert.ok(!("projectId" in clip));
  assert.ok(!("depicts" in clip));
});

test("clip -> asset -> clip preserves a top-level binding that diverges from generatedBy", () => {
  // Review metadata is written onto the top-level binding (updateGeneratedAssetReview)
  // and can differ from the generation-time generatedBy.characterBinding.
  const reviewed: Clip = {
    ...generatedClip,
    characterBinding: {
      ...generatedClip.characterBinding!,
      consistencyReview: {
        identity: "pass",
        wardrobe: "needs_review",
        style: "pass",
      },
    },
  };
  const asset = clipToAsset(reviewed, { projectId: "default", role: "beat_clip" });
  // The reviewed top-level binding is carried on its own field, not conflated
  // with the (un-reviewed) provenance binding.
  assert.deepEqual(asset.characterBinding?.consistencyReview, {
    identity: "pass",
    wardrobe: "needs_review",
    style: "pass",
  });
  assert.equal(asset.provenance?.characterBinding?.consistencyReview, undefined);
  assert.deepEqual(assetToClip(asset), reviewed);
});

test("clip -> asset -> clip preserves the firstFrameAssetId provenance input edge", () => {
  // A beat clip records the keyframe it grew from as a provenance input edge
  // (recordFirstFrameEdge). assetToClip must copy it back so materializing a
  // pooled asset doesn't lose the keyframe edge.
  const withEdge: Clip = {
    id: "vid_2",
    filename: "vid_2.mp4",
    url: "/generated/vid_2.mp4",
    kind: "video",
    durationSec: 4,
    description: "beat clip seeded from a keyframe",
    source: "generated",
    generatedBy: {
      provider: "gemini",
      prompt: "a cinematic shot",
      inputs: { firstFrameAssetId: "kf_1" },
    },
  };
  const asset = clipToAsset(withEdge, {
    projectId: "default",
    role: "beat_clip",
  });
  assert.equal(asset.provenance?.inputs?.firstFrameAssetId, "kf_1");
  assert.deepEqual(assetToClip(asset), withEdge);
});

test("clip -> asset -> clip preserves the requestFingerprint reuse key", () => {
  const withRequest: Clip = {
    id: "aud_1",
    filename: "aud_1.mp3",
    url: "/generated/aud_1.mp3",
    kind: "audio",
    durationSec: 30,
    description: "soundtrack",
    source: "generated",
    generatedBy: {
      provider: "elevenlabs",
      prompt: "music",
      requestFingerprint: "abc123",
    },
  };
  const asset = clipToAsset(withRequest, { projectId: "default", role: "soundtrack" });
  assert.equal(asset.provenance?.requestFingerprint, "abc123");
  assert.deepEqual(assetToClip(asset), withRequest);
});
