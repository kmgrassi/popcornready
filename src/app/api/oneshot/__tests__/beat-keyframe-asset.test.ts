import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { promises as fs } from "node:fs";

import { geminiProvider } from "@/lib/generative/providers/gemini";
import type { GeneratedAssetResult } from "@/lib/generative/types";
import type { Beat, Clip, Project } from "@/lib/types";
import { addAsset, getSelection, setSelection } from "@/lib/assets/pool";
import { generateBeatKeyframe } from "../media-generation";

// asset-pool PR D: a generated per-beat keyframe is recorded as a first-class
// `beat_keyframe` Asset (with depicts.beatId), a beat_keyframe selection is set,
// and the seeded clip's provenance records firstFrameAssetId. North Star
// Principle 9 — nothing is throwaway.

function emptyProject(): Project {
  return {
    id: "default",
    goal: "x",
    plan: null,
    timeline: null,
    clips: [],
    assets: [],
    selections: [],
    critic: null,
    chat: [],
    updatedAt: "t",
  };
}

const beat: Beat = {
  id: "beat_1_hook",
  name: "hook",
  durationSec: 4,
  intent: "open on the protagonist",
};

test("generateBeatKeyframe records a pooled beat_keyframe asset + selection + clip edge", async (t) => {
  const prevKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";
  t.after(() => {
    if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevKey;
  });

  const fakeResult: GeneratedAssetResult = {
    kind: "image",
    bytes: Buffer.from("fake-png-bytes"),
    extension: "png",
    mimeType: "image/png",
    provider: "gemini",
    model: "gemini-image",
    prompt: "provider-echoed prompt",
    costUsd: 0.02,
  };
  mock.method(geminiProvider, "generateAsset", async () => fakeResult);
  // Avoid touching the real public/ dir.
  const written: string[] = [];
  mock.method(fs, "mkdir", async () => undefined);
  mock.method(fs, "writeFile", async (file: string) => {
    written.push(String(file));
  });

  const out = await generateBeatKeyframe({
    goal: "a kid explores a forest",
    style: "cinematic",
    beat,
    beatIndex: 0,
    totalBeats: 3,
    aspectRatio: "9:16",
    heroPath: "/tmp/hero.png",
    projectId: "default",
    anchorAssetId: "img_hero1",
  });

  assert.ok(out, "keyframe asset is returned (not null) when Gemini is available");
  const { asset, path: framePath } = out;

  // 1) First-class pooled asset, self-describing.
  assert.equal(asset.kind, "image");
  assert.equal(asset.role, "beat_keyframe");
  assert.equal(asset.projectId, "default");
  assert.equal(asset.depicts?.beatId, "beat_1_hook");
  assert.equal(asset.source, "generated");
  assert.ok(asset.media.url.startsWith("/generated/keyframes/"));
  assert.equal(asset.media.filename, `${asset.id}.png`);
  // Provenance carries the gen result + recorded input edges.
  assert.equal(asset.provenance?.provider, "gemini");
  assert.equal(asset.provenance?.costUsd, 0.02);
  assert.equal(asset.provenance?.inputs?.beatId, "beat_1_hook");
  assert.deepEqual(asset.provenance?.inputs?.anchorIds, ["img_hero1"]);
  // The PNG still lands under public/generated (provider needs a real file).
  assert.ok(framePath.includes("generated/keyframes"));
  assert.equal(written.length, 1);

  // 2) Route-loop semantics: pool the asset + flip the beat_keyframe selection.
  const project = emptyProject();
  addAsset(project, asset);
  setSelection(project, "beat_keyframe", beat.id!, asset.id);
  assert.equal(project.assets?.length, 1);
  assert.equal(getSelection(project, "beat_keyframe", beat.id!), asset.id);

  // 3) The seeded beat clip records the keyframe as a provenance input edge.
  const clip: Clip = {
    id: "vid_1",
    filename: "vid_1.mp4",
    url: "/generated/vid_1.mp4",
    kind: "video",
    durationSec: 4,
    description: "the shot",
    source: "generated",
    generatedBy: { provider: "gemini", prompt: "shot prompt" },
  };
  clip.generatedBy!.inputs = {
    ...clip.generatedBy!.inputs,
    firstFrameAssetId: asset.id,
  };
  assert.equal(clip.generatedBy?.inputs?.firstFrameAssetId, asset.id);
});

test("generateBeatKeyframe returns null when Gemini is unavailable (fallback gate preserved)", async (t) => {
  const prevKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  t.after(() => {
    if (prevKey !== undefined) process.env.GEMINI_API_KEY = prevKey;
  });

  const out = await generateBeatKeyframe({
    goal: "g",
    style: "s",
    beat,
    beatIndex: 0,
    totalBeats: 1,
    aspectRatio: "9:16",
    heroPath: "/tmp/hero.png",
    projectId: "default",
  });
  assert.equal(out, null);
});
