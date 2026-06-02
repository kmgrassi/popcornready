import assert from "node:assert/strict";
import test from "node:test";
import type { Clip } from "@/lib/types";
import { soundtrackRequestFingerprint } from "../prompts";
import {
  legacySoundtrackContentMatches,
  soundtrackMatchesRequest,
} from "../project-cache";

const REQUEST = { goal: "explain photosynthesis", style: "cinematic", targetLengthSec: 30 };

function soundtrackClip(fingerprint: string | undefined): Clip {
  return {
    id: "aud_1",
    filename: "aud_1.mp3",
    url: "/generated/aud_1.mp3",
    kind: "audio",
    durationSec: 30,
    description: "soundtrack",
    source: "generated",
    generatedBy: {
      provider: "elevenlabs",
      prompt: "music",
      ...(fingerprint ? { requestFingerprint: fingerprint } : {}),
    },
  };
}

test("a soundtrack matches when the request fingerprint is identical", () => {
  const clip = soundtrackClip(soundtrackRequestFingerprint(REQUEST));
  assert.equal(soundtrackMatchesRequest(clip, REQUEST), true);
});

test("changing goal, style, or length stops the match", () => {
  const clip = soundtrackClip(soundtrackRequestFingerprint(REQUEST));
  assert.equal(
    soundtrackMatchesRequest(clip, { ...REQUEST, goal: "different brief" }),
    false
  );
  assert.equal(
    soundtrackMatchesRequest(clip, { ...REQUEST, style: "playful" }),
    false
  );
  assert.equal(
    soundtrackMatchesRequest(clip, { ...REQUEST, targetLengthSec: 45 }),
    false
  );
});

test("a clip without a request fingerprint never matches (regenerates once)", () => {
  assert.equal(soundtrackMatchesRequest(soundtrackClip(undefined), REQUEST), false);
});

test("a legacy clip (no fingerprint) still matches on style + approximate length", () => {
  // Pre-fingerprint soundtracks must not be dropped on upgrade. The prompt
  // carries "Visual style: <style>"; duration is within tolerance.
  const legacy = soundtrackClip(undefined);
  legacy.generatedBy!.prompt = "instrumental. Visual style: cinematic. beats…";
  legacy.measuredDurationSec = 30.4;
  assert.equal(
    legacySoundtrackContentMatches(legacy, { style: "cinematic", targetLengthSec: 30 }),
    true
  );
});

test("a legacy clip stops matching when style or length drifts", () => {
  const legacy = soundtrackClip(undefined);
  legacy.generatedBy!.prompt = "instrumental. Visual style: cinematic.";
  legacy.measuredDurationSec = 30;
  assert.equal(
    legacySoundtrackContentMatches(legacy, { style: "playful", targetLengthSec: 30 }),
    false
  );
  assert.equal(
    legacySoundtrackContentMatches(legacy, { style: "cinematic", targetLengthSec: 45 }),
    false
  );
});

test("the fingerprint depends only on goal/style/length (beats excluded by design)", () => {
  // The helper signature takes no beats, so a re-plan that rewrites the LLM beat
  // intents for the same request yields an identical reuse key — the cached
  // track is not needlessly invalidated.
  const a = soundtrackRequestFingerprint({ goal: "g", style: "s", targetLengthSec: 30 });
  const b = soundtrackRequestFingerprint({ goal: "g", style: "s", targetLengthSec: 30 });
  assert.equal(a, b);
});
