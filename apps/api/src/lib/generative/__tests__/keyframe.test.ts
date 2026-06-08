import assert from "node:assert/strict";
import test from "node:test";
import type { Project } from "@popcorn/shared/types";
import type { Asset } from "@popcorn/shared/assets/types";
import {
  FirstFrameGuardrailError,
  assertPhotorealFirstFrame,
  buildKeyframePrompt,
  isAllowedFirstFrameRole,
  keyframeProvenanceInputs,
  keyframeReferencePaths,
  selectClipFirstFrame,
} from "../keyframe";
import { addAsset, resolveBeatFirstFrameAsset, setSelection } from "../../assets/pool";

const BEAT_ID = "beat_1_hook";

function asset(overrides: Partial<Asset>): Asset {
  return {
    id: "a_1",
    projectId: "default",
    kind: "image",
    role: "beat_keyframe",
    media: { url: "/generated/a_1.png", filename: "a_1.png", durationSec: 0 },
    source: "generated",
    ...overrides,
  };
}

function projectWith(assets: Asset[]): Project {
  return {
    id: "default",
    goal: "x",
    plan: null,
    timeline: null,
    clips: [],
    assets,
    selections: [],
    critic: null,
    chat: [],
    updatedAt: "t",
  };
}

// === THE GUARDRAIL: a beat_storyboard can NEVER be a clip's first frame ===

test("assertPhotorealFirstFrame rejects a beat_storyboard sketch", () => {
  const sketch = asset({ id: "sb_1", role: "beat_storyboard" });
  assert.throws(
    () => assertPhotorealFirstFrame(sketch),
    (err: unknown) => {
      assert.ok(err instanceof FirstFrameGuardrailError);
      assert.equal((err as FirstFrameGuardrailError).assetId, "sb_1");
      assert.equal((err as FirstFrameGuardrailError).role, "beat_storyboard");
      return true;
    }
  );
});

test("assertPhotorealFirstFrame accepts a photoreal beat_keyframe", () => {
  const kf = asset({ id: "kf_1", role: "beat_keyframe" });
  assert.equal(assertPhotorealFirstFrame(kf), kf);
  assert.equal(selectClipFirstFrame(kf).id, "kf_1");
});

test("isAllowedFirstFrameRole: beat_keyframe yes, beat_storyboard no", () => {
  assert.equal(isAllowedFirstFrameRole("beat_keyframe"), true);
  assert.equal(isAllowedFirstFrameRole("beat_storyboard"), false);
});

test("resolveBeatFirstFrameAsset returns the photoreal keyframe selection", () => {
  const kf = asset({ id: "kf_1", role: "beat_keyframe", depicts: { beatId: BEAT_ID } });
  const project = projectWith([kf]);
  setSelection(project, "beat_keyframe", BEAT_ID, "kf_1");
  assert.equal(resolveBeatFirstFrameAsset(project, BEAT_ID)?.id, "kf_1");
});

test("resolveBeatFirstFrameAsset refuses to return a beat_storyboard as the first frame", () => {
  // A corrupted/mistaken selection pointing the beat_keyframe slot at a sketch
  // asset must be caught by the guardrail rather than silently flowing to a clip.
  const sketch = asset({ id: "sb_1", role: "beat_storyboard", depicts: { beatId: BEAT_ID } });
  const project = projectWith([sketch]);
  setSelection(project, "beat_keyframe", BEAT_ID, "sb_1");
  assert.throws(
    () => resolveBeatFirstFrameAsset(project, BEAT_ID),
    FirstFrameGuardrailError
  );
});

test("resolveBeatFirstFrameAsset is undefined when the beat has no keyframe yet", () => {
  const project = projectWith([]);
  assert.equal(resolveBeatFirstFrameAsset(project, BEAT_ID), undefined);
});

// === Sketch -> photoreal seeding (provenance + photoreal prompt) ===

test("keyframeProvenanceInputs records the seeding sketch as storyboardAssetId", () => {
  const inputs = keyframeProvenanceInputs({
    beatId: BEAT_ID,
    anchorAssetId: "char_1",
    storyboardAssetId: "sb_1",
  });
  assert.equal(inputs.storyboardAssetId, "sb_1");
  assert.equal(inputs.beatId, BEAT_ID);
  assert.deepEqual(inputs.anchorIds, ["char_1"]);
});

test("keyframeReferencePaths puts the character anchor first and the sketch after as a composition seed", () => {
  assert.deepEqual(
    keyframeReferencePaths({
      characterReferencePath: "/hero.png",
      storyboardSketchPath: "/sketch.png",
    }),
    ["/hero.png", "/sketch.png"]
  );
});

test("buildKeyframePrompt forces a photoreal re-render and forbids the sketch aesthetic when sketch-seeded", () => {
  const prompt = buildKeyframePrompt({
    beat: { id: BEAT_ID, name: "hook", durationSec: 4, intent: "open on the hero" },
    beatIndex: 0,
    totalBeats: 3,
    style: "gritty neo-noir",
    aspectRatio: "16:9",
    sketchSeeded: true,
  });
  const lower = prompt.toLowerCase();
  // Composition-only conditioning.
  assert.match(lower, /composition/);
  // Must be photoreal.
  assert.match(lower, /photoreal/);
  // The pencil/sketch look must be explicitly excluded.
  assert.match(lower, /pencil|linework|sketch/);
  assert.match(lower, /do not/);
});

test("addAsset keeps a beat_storyboard sketch in the pool (it just can't be a first frame)", () => {
  const sketch = asset({ id: "sb_1", role: "beat_storyboard", depicts: { beatId: BEAT_ID } });
  const project = projectWith([]);
  addAsset(project, sketch);
  assert.equal(project.assets?.length, 1);
  // It lives in the pool, but the guard refuses it as a first frame.
  assert.throws(() => assertPhotorealFirstFrame(sketch), FirstFrameGuardrailError);
});
