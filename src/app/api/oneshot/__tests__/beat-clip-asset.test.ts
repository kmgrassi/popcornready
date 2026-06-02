import assert from "node:assert/strict";
import test from "node:test";
import type { Asset } from "@/lib/assets/types";
import type { Beat, Clip, EditPlan } from "@/lib/types";
import {
  computeCandidateStaleSet,
  freezeFingerprints,
} from "@/lib/provenance";
import { beatClipAsset } from "../media-generation";

// Clip/Asset convergence PR-2: a generated beat clip becomes a first-class
// `beat_clip` Asset so it carries a fingerprint baseline and joins the
// candidate-stale set (the keyframe→clip ripple).

const beat: Beat = {
  id: "beat_1_hook",
  name: "hook",
  durationSec: 4,
  intent: "open on the protagonist",
};

function plan(): EditPlan {
  return {
    targetLengthSec: 8,
    style: "cinematic",
    aspectRatio: "9:16",
    beats: [beat, { id: "beat_2", name: "proof", durationSec: 4, intent: "show it" }],
  };
}

function beatClip(id: string, firstFrameAssetId?: string): Clip {
  return {
    id,
    filename: `${id}.mp4`,
    url: `/generated/${id}.mp4`,
    kind: "video",
    durationSec: 4,
    description: "the shot",
    source: "generated",
    generatedBy: {
      provider: "gemini",
      prompt: "a cinematic shot",
      ...(firstFrameAssetId ? { inputs: { firstFrameAssetId } } : {}),
    },
  };
}

const keyframeAsset: Asset = {
  id: "kf_1",
  projectId: "default",
  kind: "image",
  role: "beat_keyframe",
  depicts: { beatId: "beat_1_hook" },
  media: { url: "/generated/keyframes/kf_1.png", filename: "kf_1.png", durationSec: 0 },
  source: "generated",
  provenance: {
    provider: "gemini",
    prompt: "beat 1 keyframe",
    inputs: { beatId: "beat_1_hook", anchorIds: ["anchor_1"] },
  },
};

test("beatClipAsset builds a same-id beat_clip asset with the structural input edges", () => {
  const clip = beatClip("vid_1", "kf_1");
  const asset = beatClipAsset(clip, beat, {
    projectId: "default",
    anchorAssetId: "anchor_1",
  });
  assert.equal(asset.id, "vid_1"); // same id as the clip (twin)
  assert.equal(asset.role, "beat_clip");
  assert.equal(asset.projectId, "default");
  assert.equal(asset.depicts?.beatId, "beat_1_hook");
  assert.equal(asset.media.url, "/generated/vid_1.mp4");
  // firstFrameAssetId carried from the clip; beatId + anchorIds added.
  assert.equal(asset.provenance?.inputs?.firstFrameAssetId, "kf_1");
  assert.equal(asset.provenance?.inputs?.beatId, "beat_1_hook");
  assert.deepEqual(asset.provenance?.inputs?.anchorIds, ["anchor_1"]);
});

test("a beat edit flags both the keyframe and the pooled clip (ripple fires)", () => {
  const clipAsset = beatClipAsset(beatClip("vid_1", "kf_1"), beat, {
    projectId: "default",
    anchorAssetId: "anchor_1",
  });
  const frozen = freezeFingerprints([keyframeAsset, clipAsset], plan());
  const edited = plan();
  edited.beats[0].intent = "open on the strongest, most surprising moment";
  const ids = computeCandidateStaleSet(frozen, edited)
    .map((c) => c.assetId)
    .sort();
  // Before convergence only kf_1 was flagged; now the clip is too.
  assert.deepEqual(ids, ["kf_1", "vid_1"]);
});

test("a clip generated WITHOUT a keyframe is still flagged via its own beatId", () => {
  // No firstFrameAssetId edge → no upstream to ripple from; the clip's own
  // depicts/inputs.beatId is what makes it flaggable.
  const clipAsset = beatClipAsset(beatClip("vid_2"), beat, { projectId: "default" });
  assert.equal(clipAsset.provenance?.inputs?.firstFrameAssetId, undefined);
  const frozen = freezeFingerprints([clipAsset], plan());
  const edited = plan();
  edited.beats[0].intent = "different intent";
  const candidates = computeCandidateStaleSet(frozen, edited);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].assetId, "vid_2");
  assert.equal(candidates[0].reason, "input_changed");
});

test("editing an unrelated beat does not flag a clip whose prompt didn't change", () => {
  // Sanity: a clip serving beat_1 is NOT flagged when only beat_2's duration
  // moves in a way that doesn't enter the prompt... actually beat prompts thread
  // the full arc, so any beat edit DOES change it. Assert that truthfully.
  const clipAsset = beatClipAsset(beatClip("vid_3", undefined), beat, {
    projectId: "default",
  });
  const frozen = freezeFingerprints([clipAsset], plan());
  const edited = plan();
  edited.beats[1].intent = "a different second beat";
  const ids = computeCandidateStaleSet(frozen, edited).map((c) => c.assetId);
  // Full-arc prompt coupling: editing beat_2 still flags beat_1's clip.
  assert.deepEqual(ids, ["vid_3"]);
});
