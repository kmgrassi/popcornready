import assert from "node:assert/strict";
import test from "node:test";
import type { Clip, Project } from "../types";
import { Asset } from "../assets/types";
import {
  addAsset,
  findAsset,
  getSelection,
  poolAssets,
  resolveActiveAsset,
  setSelection,
} from "../assets/pool";

function emptyProject(): Project {
  return {
    id: "default",
    goal: "x",
    plan: null,
    timeline: null,
    clips: [],
    critic: null,
    chat: [],
    updatedAt: "t",
  };
}

const keyframe: Asset = {
  id: "kf_1",
  projectId: "default",
  kind: "image",
  role: "beat_keyframe",
  depicts: { beatId: "beat_1_hook" },
  media: { url: "/generated/keyframes/kf_1.png", filename: "kf_1.png", durationSec: 4 },
  source: "generated",
};

test("addAsset appends to the pool and is idempotent by id", () => {
  const p = emptyProject();
  addAsset(p, keyframe);
  addAsset(p, keyframe);
  assert.equal(p.assets?.length, 1);
  assert.equal(findAsset(p, "kf_1")?.role, "beat_keyframe");
});

test("poolAssets unifies explicit assets and clips-as-assets", () => {
  const p = emptyProject();
  addAsset(p, keyframe);
  const clip: Clip = {
    id: "vid_1",
    filename: "vid_1.mp4",
    url: "/generated/vid_1.mp4",
    kind: "video",
    durationSec: 4,
    description: "a shot",
    source: "generated",
  };
  p.clips.push(clip);

  const ids = poolAssets(p).map((a) => a.id);
  assert.deepEqual(ids, ["kf_1", "vid_1"]);
  // The clip surfaces as an asset (default role for video).
  assert.equal(findAsset(p, "vid_1")?.role, "beat_clip");
});

test("setSelection upserts and flips the active pointer; prior asset stays pooled", () => {
  const p = emptyProject();
  addAsset(p, keyframe);
  const keyframe2: Asset = { ...keyframe, id: "kf_2" };
  addAsset(p, keyframe2);

  setSelection(p, "beat_keyframe", "beat_1_hook", "kf_1");
  assert.equal(getSelection(p, "beat_keyframe", "beat_1_hook"), "kf_1");
  assert.equal(resolveActiveAsset(p, "beat_keyframe", "beat_1_hook")?.id, "kf_1");

  // Regenerate: flip to kf_2; only one selection record, both assets still pooled.
  setSelection(p, "beat_keyframe", "beat_1_hook", "kf_2");
  assert.equal(p.selections?.length, 1);
  assert.equal(resolveActiveAsset(p, "beat_keyframe", "beat_1_hook")?.id, "kf_2");
  assert.equal(p.assets?.length, 2, "the deselected asset stays in the pool");
});
