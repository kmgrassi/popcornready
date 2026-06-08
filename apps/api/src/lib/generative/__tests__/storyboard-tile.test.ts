import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import type { Beat, Scene } from "@popcorn/shared/types";
import {
  generateStoryboardTile,
  resolveStoryboardTileProvider,
} from "../storyboard-tile";
import {
  STORYBOARD_SKETCH_STYLE_PRESET,
  buildStoryboardSketchPrompt,
} from "../sketch-style";

const scene: Scene = {
  id: "scene_1",
  name: "Kitchen reveal",
  setting: "a sunlit kitchen, morning",
  mood: "warm, hopeful",
  beats: [{ id: "beat_1_hook", name: "hook", durationSec: 3, intent: "open on the steaming mug" }],
};
const beat: Beat = scene.beats[0];

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "storyboard-tile-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// --- sketch style preset ---------------------------------------------------

test("buildStoryboardSketchPrompt leads with the sketch preset, then scene + shot", () => {
  const prompt = buildStoryboardSketchPrompt({
    beatIntent: beat.intent,
    beatName: beat.name,
    sceneName: scene.name,
    setting: scene.setting,
    mood: scene.mood,
  });
  assert.ok(
    prompt.startsWith(STORYBOARD_SKETCH_STYLE_PRESET),
    "the sketch style framing dominates the prompt"
  );
  assert.match(prompt, /storyboard sketch panel/i);
  assert.match(prompt, /Scene: Kitchen reveal/);
  assert.match(prompt, /Setting: a sunlit kitchen/);
  assert.match(prompt, /Mood: warm, hopeful/);
  assert.match(prompt, /Shot \(hook\): open on the steaming mug/);
});

test("buildStoryboardSketchPrompt omits absent scene context cleanly", () => {
  const prompt = buildStoryboardSketchPrompt({ beatIntent: "a wide establishing shot" });
  assert.ok(prompt.startsWith(STORYBOARD_SKETCH_STYLE_PRESET));
  assert.doesNotMatch(prompt, /Scene:/);
  assert.doesNotMatch(prompt, /Setting:/);
  assert.match(prompt, /Shot: a wide establishing shot/);
});

// --- minor-safe provider routing ------------------------------------------

test("resolveStoryboardTileProvider forces Gemini for any minor likeness", () => {
  assert.equal(resolveStoryboardTileProvider({ provider: "openai", containsMinor: true }), "gemini");
  assert.equal(resolveStoryboardTileProvider({ provider: "openai" }), "openai");
  assert.equal(resolveStoryboardTileProvider({}), "openai");
  assert.equal(resolveStoryboardTileProvider({ provider: "mock" }), "mock");
});

// --- generateStoryboardTile ------------------------------------------------

test("generateStoryboardTile produces a beat_storyboard asset with depicts + provenance", async () => {
  await withDir(async (dir) => {
    let n = 0;
    const tile = await generateStoryboardTile({
      projectId: "proj_1",
      scene,
      beat,
      sceneAnchorAssetId: "scene_anchor_1",
      characterAnchorAssetIds: ["char_anchor_1"],
      provider: "mock",
      outputDir: dir,
      publicUrlFor: (filename) => `/generated/${filename}`,
      newId: () => `tile_${++n}`,
    });

    assert.equal(tile.role, "beat_storyboard");
    assert.equal(tile.kind, "image");
    assert.equal(tile.projectId, "proj_1");
    assert.deepEqual(tile.depicts, { beatId: "beat_1_hook" });
    assert.equal(tile.source, "generated");
    // Provenance: prompt is the sketch-style prompt; input edges trace the beat
    // + the conditioning anchors.
    assert.ok(tile.provenance);
    assert.ok(tile.provenance!.prompt.startsWith(STORYBOARD_SKETCH_STYLE_PRESET));
    assert.equal(tile.provenance!.inputs?.beatId, "beat_1_hook");
    assert.deepEqual(tile.provenance!.inputs?.anchorIds, ["scene_anchor_1", "char_anchor_1"]);
    assert.equal(tile.media.durationSec, 3);

    // Bytes were written under the storage filename (not the asset id namespace).
    const written = await fs.readFile(path.join(dir, tile.media.filename));
    assert.ok(written.length > 0, "sketch bytes were persisted");
    assert.equal(tile.media.url, `/generated/${tile.media.filename}`);
  });
});

test("generateStoryboardTile rejects a beat without a stable id", async () => {
  await withDir(async (dir) => {
    await assert.rejects(
      generateStoryboardTile({
        projectId: "proj_1",
        scene,
        beat: { name: "hook", durationSec: 3, intent: "x" },
        provider: "mock",
        outputDir: dir,
        publicUrlFor: (f) => f,
        newId: () => "tile_x",
      }),
      /stable id/
    );
  });
});
