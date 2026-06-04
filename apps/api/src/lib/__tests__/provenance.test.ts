import assert from "node:assert/strict";
import test from "node:test";
import type { Asset } from "@popcorn/shared/assets/types";
import type { EditPlan, Project } from "@popcorn/shared/types";
import { poolAssets } from "../assets/pool";
import {
  buildProvenanceGraph,
  canonicalJSON,
  computeCandidateStaleSet,
  freezeFingerprints,
  recomputeFingerprints,
  requestFingerprint,
} from "../provenance";

// --- canonicalJSON --------------------------------------------------------

test("canonicalJSON is insensitive to key order and drops undefined", () => {
  assert.equal(
    canonicalJSON({ b: 1, a: 2, c: undefined }),
    canonicalJSON({ a: 2, b: 1 })
  );
});

test("canonicalJSON preserves array order (order is semantic)", () => {
  assert.notEqual(canonicalJSON([1, 2, 3]), canonicalJSON([3, 2, 1]));
});

test("canonicalJSON sorts keys of nested objects", () => {
  assert.equal(
    canonicalJSON({ outer: { z: 1, a: 2 } }),
    JSON.stringify({ outer: { a: 2, z: 1 } })
  );
});

// --- requestFingerprint ---------------------------------------------------

test("requestFingerprint is stable and key-order independent", () => {
  assert.equal(
    requestFingerprint({ goal: "g", style: "s", len: 30 }),
    requestFingerprint({ len: 30, style: "s", goal: "g" })
  );
});

test("requestFingerprint changes when any input changes", () => {
  const base = requestFingerprint({ goal: "g", style: "s", len: 30 });
  assert.notEqual(base, requestFingerprint({ goal: "g2", style: "s", len: 30 }));
  assert.notEqual(base, requestFingerprint({ goal: "g", style: "s2", len: 30 }));
  assert.notEqual(base, requestFingerprint({ goal: "g", style: "s", len: 45 }));
});

// --- fixture --------------------------------------------------------------

function plan(): EditPlan {
  return {
    targetLengthSec: 12,
    style: "cinematic",
    aspectRatio: "9:16",
    beats: [
      { id: "beat_1", name: "hook", durationSec: 4, intent: "open strong" },
      { id: "beat_2", name: "proof", durationSec: 4, intent: "show the result" },
    ],
  };
}

const anchor: Asset = {
  id: "anchor_1",
  projectId: "default",
  kind: "image",
  role: "character_anchor",
  depicts: { characterId: "char_1" },
  media: { url: "/generated/anchor_1.png", filename: "anchor_1.png", durationSec: 4 },
  source: "generated",
  provenance: { provider: "openai", prompt: "hero portrait" },
};

// keyframe for beat_1, conditioned on the anchor
const keyframe1: Asset = {
  id: "kf_1",
  projectId: "default",
  kind: "image",
  role: "beat_keyframe",
  media: { url: "/generated/kf_1.png", filename: "kf_1.png", durationSec: 4 },
  source: "generated",
  provenance: {
    provider: "gemini",
    prompt: "beat 1 keyframe",
    inputs: { beatId: "beat_1", anchorIds: ["anchor_1"] },
  },
};

// clip for beat_1, seeded from keyframe1
const clip1: Asset = {
  id: "clip_1",
  projectId: "default",
  kind: "video",
  role: "beat_clip",
  media: { url: "/generated/clip_1.mp4", filename: "clip_1.mp4", durationSec: 4 },
  source: "generated",
  provenance: {
    provider: "gemini",
    prompt: "beat 1 clip",
    inputs: { beatId: "beat_1", anchorIds: ["anchor_1"], firstFrameAssetId: "kf_1" },
  },
};

// a stitched "final" video with NO beat of its own — depends only on the clips.
const finalVideo: Asset = {
  id: "final_1",
  projectId: "default",
  kind: "video",
  role: "beat_clip",
  media: { url: "/generated/final_1.mp4", filename: "final_1.mp4", durationSec: 8 },
  source: "generated",
  provenance: {
    provider: "internal",
    prompt: "stitch",
    inputs: { upstreamAssetIds: ["clip_1"] },
  },
};

// Freeze fingerprints onto a copy of the assets, computed against `p`.
function freeze(assets: Asset[], p: EditPlan): Asset[] {
  const fps = recomputeFingerprints(assets, p);
  return assets.map((a) => ({
    ...a,
    provenance: a.provenance
      ? { ...a.provenance, fingerprint: fps.get(a.id) }
      : a.provenance,
  }));
}

// --- recomputeFingerprints ------------------------------------------------

test("recomputeFingerprints is deterministic for identical inputs", () => {
  const a = recomputeFingerprints([anchor, keyframe1, clip1], plan());
  const b = recomputeFingerprints([anchor, keyframe1, clip1], plan());
  assert.equal(a.get("clip_1")!.inputHash, b.get("clip_1")!.inputHash);
});

test("editing a beat changes the hash of assets that serve it", () => {
  const before = recomputeFingerprints([keyframe1], plan());
  const edited = plan();
  edited.beats[0].intent = "open on the strongest, most surprising moment";
  const after = recomputeFingerprints([keyframe1], edited);
  assert.notEqual(before.get("kf_1")!.inputHash, after.get("kf_1")!.inputHash);
});

test("editing ANY beat changes a beat-asset's hash (prompt threads the full arc)", () => {
  // beatPrompt builds every shot from the whole beat map, so editing a different
  // beat still changes this asset's prompt context and must change its hash.
  const before = recomputeFingerprints([keyframe1], plan());
  const edited = plan();
  edited.beats[1].intent = "totally different proof";
  const after = recomputeFingerprints([keyframe1], edited);
  assert.notEqual(before.get("kf_1")!.inputHash, after.get("kf_1")!.inputHash);
});

test("a style change ripples to beat assets and the anchor (style is in every prompt)", () => {
  const before = recomputeFingerprints([anchor, keyframe1], plan());
  const edited = plan();
  edited.style = "playful hand-drawn animation";
  const after = recomputeFingerprints([anchor, keyframe1], edited);
  assert.notEqual(before.get("kf_1")!.inputHash, after.get("kf_1")!.inputHash);
  assert.notEqual(before.get("anchor_1")!.inputHash, after.get("anchor_1")!.inputHash);
});

test("a beat edit does NOT change the anchor hash (anchors are style-only)", () => {
  // The role-level insulation that keeps the candidate set meaningful: editing a
  // beat flags beat assets, but the character anchor (no beat dependence) stays.
  const before = recomputeFingerprints([anchor], plan());
  const edited = plan();
  edited.beats[0].intent = "open on the strongest moment";
  const after = recomputeFingerprints([anchor], edited);
  assert.equal(before.get("anchor_1")!.inputHash, after.get("anchor_1")!.inputHash);
});

test("a downstream asset folds in its upstream's hash (ripple)", () => {
  const fps = recomputeFingerprints([anchor, keyframe1, clip1], plan());
  assert.equal(fps.get("clip_1")!.upstreamHashes["kf_1"], fps.get("kf_1")!.inputHash);
  assert.equal(
    fps.get("kf_1")!.upstreamHashes["anchor_1"],
    fps.get("anchor_1")!.inputHash
  );
});

// --- buildProvenanceGraph -------------------------------------------------

test("buildProvenanceGraph indexes edges and dependents", () => {
  const g = buildProvenanceGraph([anchor, keyframe1, clip1, finalVideo]);
  assert.deepEqual(g.byId.get("clip_1")!.upstreamAssetIds, ["anchor_1", "kf_1"]);
  assert.deepEqual(g.dependentsOf.get("kf_1"), ["clip_1"]);
  assert.deepEqual(g.dependentsOf.get("clip_1"), ["final_1"]);
});

test("buildProvenanceGraph drops dangling upstream references", () => {
  const orphan: Asset = {
    ...clip1,
    id: "clip_orphan",
    provenance: {
      provider: "gemini",
      prompt: "x",
      inputs: { firstFrameAssetId: "missing_kf" },
    },
  };
  const g = buildProvenanceGraph([orphan]);
  assert.deepEqual(g.byId.get("clip_orphan")!.upstreamAssetIds, []);
});

// --- computeCandidateStaleSet ---------------------------------------------

test("no change yields an empty candidate set", () => {
  const frozen = freeze([anchor, keyframe1, clip1], plan());
  assert.deepEqual(computeCandidateStaleSet(frozen, plan()), []);
});

test("a beat edit flags the beat assets (not the anchor) as input_changed", () => {
  const frozen = freeze([anchor, keyframe1, clip1], plan());
  const edited = plan();
  edited.beats[0].intent = "open on the strongest moment";
  const candidates = computeCandidateStaleSet(frozen, edited);
  const ids = candidates.map((c) => c.assetId).sort();
  assert.deepEqual(ids, ["clip_1", "kf_1"]);
  // The anchor (no beat dependence) is untouched — role-level selectivity.
  assert.ok(!ids.includes("anchor_1"));
  for (const c of candidates) {
    assert.equal(c.reason, "input_changed");
    // The drift is in the plan context; we report "plan" plus the asset's beat.
    assert.deepEqual(c.changedInputs, ["plan", "beat_1"]);
  }
});

test("a fingerprint-version mismatch is treated as no baseline, not stale", () => {
  const frozen = freeze([keyframe1], plan()).map((a) => ({
    ...a,
    provenance: {
      ...a.provenance!,
      fingerprint: { ...a.provenance!.fingerprint!, fingerprintVersion: "fp.v0" },
    },
  }));
  // Even with a wildly different plan, an incomparable (old-version) hash must
  // not be reported stale — otherwise a shape bump flags the whole pool.
  const edited = plan();
  edited.beats[0].intent = "changed";
  assert.deepEqual(computeCandidateStaleSet(frozen, edited), []);
});

test("a beat edit ripples to a no-beat composite as upstream_stale", () => {
  const frozen = freeze([anchor, keyframe1, clip1, finalVideo], plan());
  const edited = plan();
  edited.beats[0].intent = "open on the strongest moment";
  const candidates = computeCandidateStaleSet(frozen, edited);
  const final = candidates.find((c) => c.assetId === "final_1");
  assert.ok(final, "final video should be a candidate");
  assert.equal(final!.reason, "upstream_stale");
  assert.deepEqual(final!.changedInputs, ["clip_1"]);
});

// --- freezeFingerprints ---------------------------------------------------

test("freezeFingerprints stamps a fingerprint onto generated assets", () => {
  const frozen = freezeFingerprints([anchor, keyframe1, clip1], plan());
  for (const a of frozen) {
    assert.ok(a.provenance?.fingerprint, `${a.id} should be frozen`);
    assert.equal(a.provenance!.fingerprint!.fingerprintVersion, "fp.v1");
  }
});

test("freezeFingerprints is write-once: existing fingerprints are preserved", () => {
  // Freeze against the original plan, then edit a beat and re-freeze.
  const first = freezeFingerprints([keyframe1], plan());
  const originalHash = first[0].provenance!.fingerprint!.inputHash;
  const edited = plan();
  edited.beats[0].intent = "changed";
  const second = freezeFingerprints(first, edited);
  // The already-frozen baseline must NOT be overwritten, or staleness is lost.
  assert.equal(second[0].provenance!.fingerprint!.inputHash, originalHash);
});

test("freeze then edit then compute surfaces the candidate end-to-end", () => {
  const frozen = freezeFingerprints([anchor, keyframe1, clip1], plan());
  const edited = plan();
  edited.beats[0].intent = "open on the strongest moment";
  const ids = computeCandidateStaleSet(frozen, edited)
    .map((c) => c.assetId)
    .sort();
  assert.deepEqual(ids, ["clip_1", "kf_1"]);
});

test("assets without a stored fingerprint are never candidates", () => {
  // anchor frozen, keyframe NOT frozen (legacy asset)
  const frozen = freeze([anchor], plan());
  const mixed = [...frozen, keyframe1];
  const edited = plan();
  edited.beats[0].intent = "changed";
  const candidates = computeCandidateStaleSet(mixed, edited);
  assert.ok(!candidates.some((c) => c.assetId === "kf_1"));
});

// --- unified pool: generated clips still in clips[] become graph nodes --------

test("a generated beat video in clips[] surfaces as a graph node + keyframe edge", () => {
  // Until Clip/Asset convergence, generated videos live in clips[], not assets[].
  // The read API builds over poolAssets() so the graph still sees the clip and
  // its firstFrameAssetId edge to the pooled keyframe.
  const project = {
    id: "default",
    assets: [keyframe1],
    clips: [
      {
        id: "vid_1",
        filename: "vid_1.mp4",
        url: "/generated/vid_1.mp4",
        kind: "video",
        durationSec: 4,
        description: "beat 1 clip",
        source: "generated",
        generatedBy: { provider: "gemini", prompt: "shot", inputs: { firstFrameAssetId: "kf_1" } },
      },
    ],
  } as unknown as Project;

  const graph = buildProvenanceGraph(poolAssets(project));
  assert.ok(graph.byId.has("vid_1"), "clip should be a graph node");
  assert.deepEqual(graph.byId.get("vid_1")!.upstreamAssetIds, ["kf_1"]);
  assert.deepEqual(graph.dependentsOf.get("kf_1"), ["vid_1"]);
});
