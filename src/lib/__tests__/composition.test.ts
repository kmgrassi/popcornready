import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCompositionConstraints,
  buildCompositionPlan,
  parseCompositionMode,
  resolveAssetPolicy,
  resolveProviderDefaults,
  type BuildCompositionInput,
  type PlannedBeatProposal,
} from "../composition";
import { Clip } from "../types";

function idFactory(): (prefix: string) => string {
  const counts: Record<string, number> = {};
  return (prefix: string) => {
    counts[prefix] = (counts[prefix] || 0) + 1;
    return `${prefix}_${counts[prefix]}`;
  };
}

function clip(id: string, kind: Clip["kind"] = "video"): Clip {
  return {
    id,
    filename: `${id}.mp4`,
    url: `/uploads/${id}.mp4`,
    kind,
    durationSec: 5,
    description: "",
  };
}

function build(
  overrides: Partial<BuildCompositionInput> & {
    beats: PlannedBeatProposal[];
  }
) {
  return buildCompositionPlan({
    projectId: "default",
    mode: "prompt_only",
    availableAssets: [],
    providers: resolveProviderDefaults(),
    assetPolicy: resolveAssetPolicy(),
    newId: idFactory(),
    now: () => new Date("2026-05-28T00:00:00.000Z"),
    ...overrides,
  });
}

test("parseCompositionMode accepts known modes and rejects others", () => {
  assert.equal(parseCompositionMode("hybrid"), "hybrid");
  assert.equal(parseCompositionMode("prompt_only"), "prompt_only");
  assert.equal(parseCompositionMode("asset_driven"), "asset_driven");
  assert.throws(() => parseCompositionMode("bogus"), /Unsupported composition mode/);
});

test("resolveProviderDefaults honors allowed-provider overrides", () => {
  const defaults = resolveProviderDefaults();
  assert.deepEqual(defaults, {
    image: "openai",
    video: "gemini",
    audio: "elevenlabs",
  });
  const overridden = resolveProviderDefaults({
    allowedProviders: { image: ["mock"], video: ["openai"] },
  });
  assert.equal(overridden.image, "mock");
  assert.equal(overridden.video, "openai");
  assert.equal(overridden.audio, "elevenlabs");
});

test("prompt_only plans a generation job for every beat plus narration", () => {
  const { composition, jobs } = build({
    mode: "prompt_only",
    availableAssets: [clip("asset_ignored")],
    beats: [
      { name: "hook", intent: "grab attention", durationSec: 4, generationKind: "image" },
      { name: "reveal", intent: "show motion", durationSec: 6, generationKind: "video" },
    ],
    narration: { mode: "generate", script: "Here is the story." },
  });

  assert.equal(composition.mode, "prompt_only");
  assert.equal(composition.status, "ready_for_timeline");
  // 2 visual jobs + 1 narration job.
  assert.equal(jobs.length, 3);
  assert.deepEqual(
    composition.generatedAssetJobIds,
    jobs.map((j) => j.id)
  );

  const image = jobs.find((j) => j.kind === "image");
  const video = jobs.find((j) => j.kind === "video");
  const audio = jobs.find((j) => j.kind === "audio");
  assert.equal(image?.provider, "openai");
  assert.equal(video?.provider, "gemini");
  assert.equal(audio?.provider, "elevenlabs");
  assert.ok(jobs.every((j) => j.status === "queued"));

  assert.equal(composition.plannedBeats[0].assetStrategy, "generate_image");
  assert.equal(composition.plannedBeats[1].assetStrategy, "generate_video");
  assert.equal(composition.narrationStrategy?.mode, "generate");
  // Provided assets are ignored in prompt_only mode.
  assert.ok(composition.plannedBeats.every((b) => !b.requiredAssetIds));
});

test("hybrid reuses provided assets and only generates missing beats", () => {
  const { composition, jobs } = build({
    mode: "hybrid",
    availableAssets: [clip("asset_real")],
    beats: [
      {
        name: "intro",
        intent: "use the supplied footage",
        durationSec: 5,
        assetStrategy: "use_existing",
        requiredAssetIds: ["asset_real"],
      },
      {
        name: "cutaway",
        intent: "missing b-roll",
        durationSec: 3,
        assetStrategy: "generate_image",
        generationKind: "image",
      },
    ],
    narration: { mode: "none" },
  });

  assert.equal(composition.status, "ready_for_timeline");
  // Only the missing beat generates.
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].beatName, "cutaway");

  const [intro, cutaway] = composition.plannedBeats;
  assert.equal(intro.assetStrategy, "use_existing");
  assert.deepEqual(intro.requiredAssetIds, ["asset_real"]);
  assert.equal(cutaway.assetStrategy, "generate_image");
  assert.deepEqual(cutaway.generatedAssetJobIds, [jobs[0].id]);
  assert.equal(composition.narrationStrategy?.mode, "none");
});

test("generate_video without generationKind still queues a video job", () => {
  const { composition, jobs } = build({
    mode: "prompt_only",
    beats: [
      {
        name: "motion",
        intent: "needs real motion",
        durationSec: 5,
        assetStrategy: "generate_video",
        // generationKind intentionally omitted
      },
    ],
    narration: { mode: "none" },
  });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].kind, "video");
  assert.equal(jobs[0].provider, "gemini");
  assert.equal(composition.plannedBeats[0].assetStrategy, "generate_video");
});

test("hybrid generates when a use_existing beat has no usable asset", () => {
  const { jobs } = build({
    mode: "hybrid",
    availableAssets: [clip("asset_real")],
    beats: [
      {
        name: "orphan",
        intent: "no asset attached",
        durationSec: 3,
        assetStrategy: "use_existing",
        requiredAssetIds: [],
      },
    ],
    narration: { mode: "none" },
  });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].kind, "image");
});

test("asset_driven uses only existing assets", () => {
  const { composition, jobs } = build({
    mode: "asset_driven",
    availableAssets: [clip("asset_real")],
    beats: [
      {
        name: "scene",
        intent: "supplied footage",
        durationSec: 5,
        assetStrategy: "use_existing",
        requiredAssetIds: ["asset_real"],
      },
    ],
    narration: { mode: "none" },
  });
  assert.equal(jobs.length, 0);
  assert.equal(composition.status, "ready_for_timeline");
  assert.equal(composition.plannedBeats[0].assetStrategy, "use_existing");
});

test("asset_driven rejects beats with no existing asset", () => {
  assert.throws(
    () =>
      build({
        mode: "asset_driven",
        availableAssets: [clip("asset_real")],
        beats: [
          { name: "scene", intent: "needs an asset", durationSec: 5 },
        ],
        narration: { mode: "none" },
      }),
    /asset_driven requires beat/
  );
});

test("dangling asset references are rejected", () => {
  assert.throws(
    () =>
      build({
        mode: "hybrid",
        availableAssets: [clip("asset_real")],
        beats: [
          {
            name: "scene",
            intent: "bad ref",
            durationSec: 5,
            assetStrategy: "use_existing",
            requiredAssetIds: ["ghost"],
          },
        ],
        narration: { mode: "none" },
      }),
    /references unknown asset/
  );
});

test("generation caps are enforced", () => {
  assert.throws(
    () =>
      build({
        mode: "prompt_only",
        beats: [
          { name: "a", intent: "x", durationSec: 2, generationKind: "image" },
          { name: "b", intent: "x", durationSec: 2, generationKind: "image" },
          { name: "c", intent: "x", durationSec: 2, generationKind: "image" },
        ],
        assetPolicy: resolveAssetPolicy({ maxGeneratedImages: 2 }),
        narration: { mode: "none" },
      }),
    /maxGeneratedImages is 2/
  );
});

test("missing beats become gaps when generation is disabled", () => {
  const { composition, jobs } = build({
    mode: "hybrid",
    availableAssets: [clip("asset_real")],
    beats: [
      {
        name: "missing",
        intent: "would need generation",
        durationSec: 4,
        assetStrategy: "generate_image",
        generationKind: "image",
      },
    ],
    assetPolicy: resolveAssetPolicy({ generateMissingAssets: false }),
    narration: { mode: "none" },
  });
  assert.equal(composition.status, "needs_assets");
  assert.equal(jobs.length, 0);
  assert.deepEqual(composition.plannedBeats[0].generatedAssetJobIds, []);
});

test("provided narration validates the referenced audio asset", () => {
  const { composition } = build({
    mode: "prompt_only",
    beats: [{ name: "a", intent: "x", durationSec: 2, generationKind: "image" }],
    narration: { mode: "provided", audioAssetId: "asset_audio" },
    availableAssets: [clip("asset_audio", "audio")],
  });
  assert.equal(composition.narrationStrategy?.mode, "provided");
  assert.equal(composition.narrationStrategy?.audioAssetId, "asset_audio");

  assert.throws(
    () =>
      build({
        mode: "prompt_only",
        beats: [{ name: "a", intent: "x", durationSec: 2, generationKind: "image" }],
        narration: { mode: "provided", audioAssetId: "missing_audio" },
      }),
    /Narration references unknown audio asset/
  );

  assert.throws(
    () =>
      build({
        mode: "prompt_only",
        beats: [{ name: "a", intent: "x", durationSec: 2, generationKind: "image" }],
        narration: { mode: "provided", audioAssetId: "asset_video" },
        availableAssets: [clip("asset_video", "video")],
      }),
    /is not an audio asset/
  );
});

test("assertCompositionConstraints enforces must-use and avoid lists", () => {
  const { composition } = build({
    mode: "hybrid",
    availableAssets: [clip("asset_real"), clip("asset_other")],
    beats: [
      {
        name: "intro",
        intent: "supplied footage",
        durationSec: 5,
        assetStrategy: "use_existing",
        requiredAssetIds: ["asset_real"],
      },
    ],
    narration: { mode: "none" },
  });

  // Satisfied: asset_real is used; asset_other is not.
  assert.doesNotThrow(() =>
    assertCompositionConstraints(composition, {
      mustUseAssetIds: ["asset_real"],
      avoidAssetIds: ["asset_other"],
    })
  );
  // Must-use asset missing from the plan.
  assert.throws(
    () =>
      assertCompositionConstraints(composition, {
        mustUseAssetIds: ["asset_other"],
      }),
    /omits required asset/
  );
  // Avoided asset present in the plan.
  assert.throws(
    () =>
      assertCompositionConstraints(composition, {
        avoidAssetIds: ["asset_real"],
      }),
    /uses an avoided asset/
  );
});

test("assertCompositionConstraints is skipped for prompt_only", () => {
  const { composition } = build({
    mode: "prompt_only",
    beats: [{ name: "a", intent: "x", durationSec: 2, generationKind: "image" }],
    narration: { mode: "none" },
  });
  // prompt_only ignores provided assets, so asset constraints never apply.
  assert.doesNotThrow(() =>
    assertCompositionConstraints(composition, {
      mustUseAssetIds: ["anything"],
      avoidAssetIds: ["whatever"],
    })
  );
});
