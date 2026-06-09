import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../errors";
import {
  inferKindFromName,
  parseAnalyzeAsset,
  parseBrief,
  parseCreateProject,
  parsePagination,
  parseRegisterAsset,
  parseSetAssetVisibility,
  parseUpdateAssetContext,
  parseUpdateProjectPlan,
} from "../schemas";

test("parseSetAssetVisibility accepts public and private", () => {
  assert.equal(parseSetAssetVisibility({ visibility: "public" }).visibility, "public");
  assert.equal(parseSetAssetVisibility({ visibility: "private" }).visibility, "private");
});

test("parseSetAssetVisibility rejects missing or invalid values", () => {
  expectApiError(() => parseSetAssetVisibility({}), "validation_failed");
  expectApiError(() => parseSetAssetVisibility({ visibility: "hidden" }), "validation_failed");
  expectApiError(() => parseSetAssetVisibility(null), "validation_failed");
});

function expectApiError(fn: () => unknown, code: string): ApiError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ApiError, "expected an ApiError");
    assert.equal(err.code, code);
    return err;
  }
  throw new Error("expected the function to throw");
}

test("parseBrief accepts a minimal valid brief", () => {
  const brief = parseBrief({
    goal: "Punchy teaser",
    targetLengthSec: 15,
    aspectRatio: "9:16",
  });
  assert.equal(brief.goal, "Punchy teaser");
  assert.equal(brief.targetLengthSec, 15);
  assert.equal(brief.aspectRatio, "9:16");
});

test("parseBrief reports all invalid fields with paths", () => {
  const err = expectApiError(
    () => parseBrief({ goal: "", targetLengthSec: 9000, aspectRatio: "4:3" }),
    "validation_failed"
  );
  const paths = (err.details?.fields || []).map((f) => f.path).sort();
  assert.deepEqual(
    paths,
    ["brief.goal", "brief.targetLengthSec", "brief.aspectRatio"].sort()
  );
});

test("parseBrief rejects non-string optional text fields", () => {
  const err = expectApiError(
    () =>
      parseBrief({
        goal: "g",
        targetLengthSec: 10,
        aspectRatio: "1:1",
        audience: 42,
        style: { not: "a string" },
      }),
    "validation_failed"
  );
  const paths = (err.details?.fields || []).map((f) => f.path).sort();
  assert.deepEqual(paths, ["brief.audience", "brief.style"].sort());
});

test("parseBrief validates nested narration mode", () => {
  expectApiError(
    () =>
      parseBrief({
        goal: "g",
        targetLengthSec: 10,
        aspectRatio: "1:1",
        narration: { mode: "shout" },
      }),
    "validation_failed"
  );
});

test("parseCreateProject requires a name and parses an optional brief", () => {
  expectApiError(() => parseCreateProject({}), "validation_failed");
  const input = parseCreateProject({
    name: "Demo",
    brief: { goal: "g", targetLengthSec: 10, aspectRatio: "16:9" },
  });
  assert.equal(input.name, "Demo");
  assert.equal(input.brief?.aspectRatio, "16:9");
});

test("parseRegisterAsset accepts remote_url and infers kind from extension", () => {
  const input = parseRegisterAsset({
    source: { type: "remote_url", url: "https://cdn.example.com/clip.mp4" },
  });
  assert.equal(input.source.type, "remote_url");
});

test("parseRegisterAsset rejects a non-http remote url", () => {
  expectApiError(
    () => parseRegisterAsset({ source: { type: "remote_url", url: "ftp://x/y.mp4" } }),
    "validation_failed"
  );
});

test("parseRegisterAsset accepts local_path and a generated source", () => {
  const local = parseRegisterAsset({
    source: { type: "local_path", path: "/tmp/clip.mp4" },
  });
  assert.equal(local.source.type, "local_path");

  const generated = parseRegisterAsset({
    source: { type: "generated", generatedAssetId: "gen_1" },
  });
  assert.equal(generated.source.type, "generated");
});

test("parseRegisterAsset preserves video agentContext usable moments", () => {
  const input = parseRegisterAsset({
    source: { type: "remote_url", url: "https://cdn.example.com/analyzed.mp4" },
    agentContext: {
      summary: "Launch applause and product reveal.",
      mediaType: "video",
      subjects: ["founder", "audience"],
      likelyUses: ["primary_footage"],
      cautions: [],
      confidence: "high",
      sampledAssetIds: ["frame_1"],
      model: { provider: "openai", model: "vision-test" },
      visualSubjects: ["founder at podium"],
      shotTypes: ["wide"],
      sampledFrames: ["frame_1"],
      usableMoments: [
        {
          startSec: 2,
          endSec: 5,
          label: "applause",
          description: "Audience applauds after the launch reveal.",
          suggestedUse: "proof",
        },
      ],
    },
  });

  assert.equal(input.agentContext?.mediaType, "video");
  assert.deepEqual(
    input.agentContext && "usableMoments" in input.agentContext
      ? input.agentContext.usableMoments
      : [],
    [
      {
        startSec: 2,
        endSec: 5,
        label: "applause",
        description: "Audience applauds after the launch reveal.",
        suggestedUse: "proof",
      },
    ]
  );
});

test("parseRegisterAsset rejects an unknown source type", () => {
  expectApiError(
    () => parseRegisterAsset({ source: { type: "magic" } }),
    "validation_failed"
  );
});

test("parseUpdateAssetContext returns only provided context fields", () => {
  const input = parseUpdateAssetContext({
    context: {
      summary: "Corrected clip summary.",
    },
  });
  assert.equal(input.context?.summary, "Corrected clip summary.");
  assert.equal("transcriptText" in (input.context ?? {}), false);
  assert.equal("moments" in (input.context ?? {}), false);
});

test("parseAnalyzeAsset accepts regenerate options", () => {
  const input = parseAnalyzeAsset({
    regenerate: true,
    analysisOptions: { sampleFrames: true, transcribeAudio: false },
  });
  assert.equal(input.regenerate, true);
  assert.equal(input.analysisOptions?.sampleFrames, true);
  assert.equal(input.analysisOptions?.transcribeAudio, false);
});

test("inferKindFromName maps extensions to kinds", () => {
  assert.equal(inferKindFromName("a.mp4"), "video");
  assert.equal(inferKindFromName("a.PNG"), "image");
  assert.equal(inferKindFromName("a.wav"), "audio");
  assert.equal(inferKindFromName("a.txt"), undefined);
});

test("parsePagination enforces limit bounds", () => {
  const def = parsePagination(new URLSearchParams());
  assert.equal(def.limit, 50);
  assert.equal(def.cursor, null);

  const custom = parsePagination(new URLSearchParams("limit=10&cursor=abc"));
  assert.equal(custom.limit, 10);
  assert.equal(custom.cursor, "abc");

  expectApiError(
    () => parsePagination(new URLSearchParams("limit=500")),
    "validation_failed"
  );
});

test("parseUpdateProjectPlan accepts scenes -> beats with stable ids", () => {
  const plan = parseUpdateProjectPlan({
    targetLengthSec: 30,
    style: "punchy",
    aspectRatio: "9:16",
    scenes: [
      {
        id: "scene_1",
        name: "Setup",
        setting: "kitchen, morning",
        characterIds: ["char_a"],
        beats: [
          { id: "beat_1", name: "hook", intent: "open strong", durationSec: 3 },
          { id: "beat_2", name: "problem", intent: "show pain", durationSec: 4 },
        ],
      },
    ],
  });

  assert.equal(plan.scenes?.length, 1);
  assert.equal(plan.scenes?.[0].id, "scene_1");
  assert.deepEqual(
    plan.scenes?.[0].beats.map((b) => b.id),
    ["beat_1", "beat_2"]
  );
});

test("parseUpdateProjectPlan rejects a beat with no id", () => {
  expectApiError(
    () =>
      parseUpdateProjectPlan({
        targetLengthSec: 30,
        style: "x",
        aspectRatio: "9:16",
        scenes: [
          { id: "scene_1", name: "S", beats: [{ name: "b", intent: "i", durationSec: 2 }] },
        ],
      }),
    "validation_failed"
  );
});

test("parseUpdateProjectPlan rejects duplicate beat ids across scenes", () => {
  expectApiError(
    () =>
      parseUpdateProjectPlan({
        targetLengthSec: 30,
        style: "x",
        aspectRatio: "9:16",
        scenes: [
          { id: "s1", name: "S1", beats: [{ id: "dup", name: "a", intent: "i", durationSec: 2 }] },
          { id: "s2", name: "S2", beats: [{ id: "dup", name: "b", intent: "i", durationSec: 2 }] },
        ],
      }),
    "validation_failed"
  );
});

test("parseUpdateProjectPlan rejects a missing scenes array", () => {
  expectApiError(
    () => parseUpdateProjectPlan({ targetLengthSec: 30, style: "x", aspectRatio: "9:16" }),
    "validation_failed"
  );
});
