import assert from "node:assert/strict";
import test from "node:test";
import type { Asset } from "@/lib/assets/types";
import type { Beat, Clip, EditPlan, Project } from "@/lib/types";
import { getSelection } from "@/lib/assets/pool";
import {
  computeCandidateStaleSet,
  freezeFingerprints,
} from "@/lib/provenance";
import { beatClipAsset } from "../media-generation";
import { poolResumedBeatClips } from "../project-cache";

// Clip/Asset convergence PR-3: clips carried in from a resumed run must also be
// pooled as beat_clip assets, so resumed clips get a frozen baseline and stay
// visible to getStaleCandidates — without losing a prior run's frozen fingerprint.

const beats: Beat[] = [
  { id: "beat_1_hook", name: "hook", durationSec: 4, intent: "open" },
  { id: "beat_2", name: "proof", durationSec: 4, intent: "show it" },
];

function plan(): EditPlan {
  return { targetLengthSec: 8, style: "cinematic", aspectRatio: "9:16", beats };
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
      prompt: "a shot",
      ...(firstFrameAssetId ? { inputs: { firstFrameAssetId } } : {}),
    },
  };
}

function poolProject(assets: Asset[] = []): Project {
  return {
    id: "default",
    goal: "g",
    plan: null,
    timeline: null,
    clips: [],
    assets,
    selections: [],
    critic: null,
    chat: [],
    updatedAt: "t",
  } as unknown as Project;
}

test("poolResumedBeatClips pools each resumed clip as a beat_clip asset + selection", () => {
  const pool = poolProject();
  poolResumedBeatClips(pool, [beatClip("vid_1"), beatClip("vid_2")], plan(), "anchor_1");

  assert.equal(pool.assets!.length, 2);
  assert.equal(pool.assets!.find((a) => a.id === "vid_1")?.role, "beat_clip");
  // Mapped to beats positionally, with a beat_clip selection per beat.
  assert.equal(pool.assets!.find((a) => a.id === "vid_1")?.depicts?.beatId, "beat_1_hook");
  assert.equal(pool.assets!.find((a) => a.id === "vid_2")?.depicts?.beatId, "beat_2");
  assert.equal(getSelection(pool, "beat_clip", "beat_1_hook"), "vid_1");
  assert.equal(getSelection(pool, "beat_clip", "beat_2"), "vid_2");
});

test("poolResumedBeatClips preserves an already-frozen baseline (resume seed)", () => {
  // Prior run pooled + froze the clip asset; resume seeds the pool with it.
  const clip = beatClip("vid_1", "kf_1");
  const [frozen] = freezeFingerprints(
    [beatClipAsset(clip, beats[0], { projectId: "default", anchorAssetId: "anchor_1" })],
    plan()
  );
  assert.ok(frozen.provenance?.fingerprint, "prior run froze the clip asset");
  const pool = poolProject([frozen]);

  poolResumedBeatClips(pool, [clip], plan(), "anchor_1");

  assert.equal(pool.assets!.length, 1, "no duplicate twin");
  assert.ok(
    pool.assets![0].provenance?.fingerprint,
    "the frozen baseline survived (addAsset no-ops on the existing id)"
  );
});

test("a legacy resumed clip with no prior asset is pooled and flagged after a beat edit", () => {
  // Interrupted project from before convergence: clips[] but no beat_clip asset.
  const pool = poolProject();
  poolResumedBeatClips(pool, [beatClip("vid_1")], plan());

  // saveProject would freeze the fresh asset; then a beat edit must flag it.
  const frozen = freezeFingerprints(pool.assets!, plan());
  const edited = plan();
  edited.beats[0].intent = "a different opening";
  const ids = computeCandidateStaleSet(frozen, edited).map((c) => c.assetId);
  assert.deepEqual(ids, ["vid_1"]);
});
