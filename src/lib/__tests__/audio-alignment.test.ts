import assert from "node:assert/strict";
import test from "node:test";
import {
  compareDurations,
  countWords,
  estimateWordsForDuration,
  evaluateExportPolicy,
} from "../audio-alignment";

test("compareDurations reports delta, threshold, and which side is longer", () => {
  const audioLonger = compareDurations({
    timelineDurationSec: 30,
    audioDurationSec: 34,
    maxDeltaSec: 1,
  });
  assert.equal(audioLonger.deltaSec, 4);
  assert.equal(audioLonger.withinThreshold, false);
  assert.equal(audioLonger.longer, "audio");

  const aligned = compareDurations({
    timelineDurationSec: 30,
    audioDurationSec: 30.5,
    maxDeltaSec: 1,
  });
  assert.equal(aligned.withinThreshold, true);
  assert.equal(aligned.longer, "audio");

  const exact = compareDurations({
    timelineDurationSec: 30,
    audioDurationSec: 30,
  });
  assert.equal(exact.longer, "none");
});

test("evaluateExportPolicy with no audio renders the timeline duration", () => {
  const result = evaluateExportPolicy({
    policy: "fail_on_mismatch",
    timelineDurationSec: 30,
    audioDurationSec: 0,
  });
  assert.equal(result.ok, true);
  assert.equal(result.exportDurationSec, 30);
  assert.equal(result.truncatesAudio, false);
});

test("timeline_only flags truncation but never silently cuts narration", () => {
  const result = evaluateExportPolicy({
    policy: "timeline_only",
    timelineDurationSec: 20,
    audioDurationSec: 28,
    maxDeltaSec: 1,
  });
  assert.equal(result.ok, true);
  assert.equal(result.exportDurationSec, 20);
  assert.equal(result.truncatesAudio, true);
  assert.match(result.warning || "", /cut/i);
});

test("timeline_only flags sub-threshold overruns instead of cutting silently", () => {
  // 30.8s narration over a 30.0s timeline: delta (0.8s) is within the default
  // 1s threshold, but the audio is still truncated and must be reported.
  const result = evaluateExportPolicy({
    policy: "timeline_only",
    timelineDurationSec: 30,
    audioDurationSec: 30.8,
  });
  assert.equal(result.truncatesAudio, true);
  assert.match(result.warning || "", /cut/i);
});

test("timeline_only does not flag truncation when audio fits", () => {
  const result = evaluateExportPolicy({
    policy: "timeline_only",
    timelineDurationSec: 30,
    audioDurationSec: 28,
  });
  assert.equal(result.truncatesAudio, false);
  assert.equal(result.warning, undefined);
});

test("match_longest_media extends to the longer media so audio plays fully", () => {
  const result = evaluateExportPolicy({
    policy: "match_longest_media",
    timelineDurationSec: 20,
    audioDurationSec: 28,
    maxDeltaSec: 1,
  });
  assert.equal(result.ok, true);
  assert.equal(result.exportDurationSec, 28);
  assert.equal(result.truncatesAudio, false);
});

test("fail_on_mismatch blocks export and returns typed diagnostics", () => {
  const result = evaluateExportPolicy({
    policy: "fail_on_mismatch",
    timelineDurationSec: 20,
    audioDurationSec: 28,
    maxDeltaSec: 1,
  });
  assert.equal(result.ok, false);
  assert.ok(result.error);
  assert.equal(result.error?.code, "audio_timeline_mismatch");
  assert.equal(result.error?.details.deltaSec, 8);
  assert.ok(result.error?.details.suggestedStrategies.includes("rewrite_script"));
  assert.ok(result.error?.details.suggestedStrategies.includes("extend_timeline"));
});

test("fail_on_mismatch within threshold proceeds to the longer duration", () => {
  const result = evaluateExportPolicy({
    policy: "fail_on_mismatch",
    timelineDurationSec: 20,
    audioDurationSec: 20.5,
    maxDeltaSec: 1,
  });
  assert.equal(result.ok, true);
  assert.equal(result.exportDurationSec, 20.5);
});

test("defaults to match_longest_media when no policy is given", () => {
  const result = evaluateExportPolicy({
    timelineDurationSec: 10,
    audioDurationSec: 15,
  });
  assert.equal(result.policy, "match_longest_media");
  assert.equal(result.exportDurationSec, 15);
  assert.equal(result.ok, true);
});

test("estimateWordsForDuration and countWords", () => {
  assert.equal(estimateWordsForDuration(10, 2.5), 25);
  assert.equal(estimateWordsForDuration(0), 1); // never zero
  assert.equal(countWords("  hello   world  "), 2);
  assert.equal(countWords(""), 0);
});
