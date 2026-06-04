import assert from "node:assert/strict";
import test from "node:test";

import {
  boundarySampleDurationSec,
  type StitchClip,
} from "./stitch-continuity-review";

function clip(input: Partial<StitchClip> = {}): StitchClip {
  return {
    segmentId: "seg-1",
    beat: "hook",
    videoPath: "/clips/seg-1.mp4",
    durationSec: 5,
    ...input,
  };
}

test("boundary frame extraction prefers measured duration when available", () => {
  assert.equal(
    boundarySampleDurationSec(clip({ durationSec: 5, measuredDurationSec: 3.2 })),
    3.2
  );
});

test("boundary frame extraction falls back to planned duration", () => {
  assert.equal(boundarySampleDurationSec(clip({ durationSec: 5 })), 5);
});
