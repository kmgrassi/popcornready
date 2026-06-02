import assert from "node:assert/strict";
import test from "node:test";
import type { Clip } from "@/lib/types";
import { soundtrackRequestFingerprint } from "../prompts";
import { soundtrackMatchesRequest } from "../project-cache";

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

test("the fingerprint depends only on goal/style/length (beats excluded by design)", () => {
  // The helper signature takes no beats, so a re-plan that rewrites the LLM beat
  // intents for the same request yields an identical reuse key — the cached
  // track is not needlessly invalidated.
  const a = soundtrackRequestFingerprint({ goal: "g", style: "s", targetLengthSec: 30 });
  const b = soundtrackRequestFingerprint({ goal: "g", style: "s", targetLengthSec: 30 });
  assert.equal(a, b);
});
