import assert from "node:assert/strict";
import test from "node:test";
import { estimateCostUsd } from "../pricing";

test("video cost scales at ~$0.50 per second", () => {
  assert.equal(
    estimateCostUsd({ provider: "openai", kind: "video", durationSec: 8 }),
    4
  );
  assert.equal(
    estimateCostUsd({ provider: "gemini", kind: "video", durationSec: 4 }),
    2
  );
});

test("image cost is a flat per-generation rate", () => {
  assert.equal(estimateCostUsd({ provider: "openai", kind: "image" }), 0.05);
  assert.equal(estimateCostUsd({ provider: "gemini", kind: "image" }), 0.05);
});

test("audio cost scales with measured duration", () => {
  assert.equal(
    estimateCostUsd({
      provider: "elevenlabs",
      kind: "audio",
      durationSec: 12,
    }),
    0.12
  );
});

test("missing duration on video/audio returns zero", () => {
  assert.equal(estimateCostUsd({ provider: "openai", kind: "video" }), 0);
  assert.equal(estimateCostUsd({ provider: "elevenlabs", kind: "audio" }), 0);
});

test("mock provider is free", () => {
  assert.equal(
    estimateCostUsd({ provider: "mock", kind: "video", durationSec: 30 }),
    0
  );
  assert.equal(estimateCostUsd({ provider: "mock", kind: "image" }), 0);
});

test("negative or non-finite durations are treated as zero", () => {
  assert.equal(
    estimateCostUsd({ provider: "openai", kind: "video", durationSec: -5 }),
    0
  );
  assert.equal(
    estimateCostUsd({
      provider: "openai",
      kind: "video",
      durationSec: Number.NaN,
    }),
    0
  );
});
