import assert from "node:assert/strict";
import test from "node:test";
import {
  createDialogueAudio,
  createMusicAudio,
  createSoundEffectAudio,
  createSpeechAudio,
  estimateMp3DurationSec,
  stripSpeechDirectives,
} from "../audio";

function mp3FrameSequence(frameCount: number): Buffer {
  const frame = Buffer.alloc(417);
  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = 0x90;
  frame[3] = 0x00;
  return Buffer.concat(Array.from({ length: frameCount }, () => frame));
}

test("stripSpeechDirectives removes leading TTS instruction blocks", () => {
  const text = stripSpeechDirectives(`[Voice direction for ElevenLabs: warm narrator.]

Before antibiotics, a scratch could kill.`);

  assert.equal(text, "Before antibiotics, a scratch could kill.");
});

test("stripSpeechDirectives preserves narration without directives", () => {
  assert.equal(
    stripSpeechDirectives("Before antibiotics, a scratch could kill."),
    "Before antibiotics, a scratch could kill."
  );
});

test("estimateMp3DurationSec returns undefined for non-MP3 bytes", () => {
  assert.equal(estimateMp3DurationSec(Buffer.from("not an mp3")), undefined);
});

test("estimateMp3DurationSec measures MPEG audio frames", () => {
  assert.equal(estimateMp3DurationSec(mp3FrameSequence(10)), 11520 / 44100);
});

test("ElevenLabs audio helpers preserve measured MP3 durations", async () => {
  const previousKey = process.env.ELEVENLABS_API_KEY;
  const previousFetch = globalThis.fetch;
  const bytes = mp3FrameSequence(10);
  const expectedDuration = 11520 / 44100;
  process.env.ELEVENLABS_API_KEY = "test-key";
  globalThis.fetch = async () =>
    new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { "Content-Type": "audio/mpeg" },
    });

  try {
    const results = await Promise.all([
      createSpeechAudio({
        provider: "elevenlabs",
        kind: "audio",
        prompt: "Narration.",
      }),
      createDialogueAudio({
        provider: "elevenlabs",
        kind: "audio",
        prompt: "",
        dialogueInputs: [{ text: "Line.", voiceId: "voice-id" }],
      }),
      createSoundEffectAudio({
        provider: "elevenlabs",
        kind: "audio",
        prompt: "Door closes.",
      }),
      createMusicAudio({
        provider: "elevenlabs",
        kind: "audio",
        prompt: "Sparse piano.",
      }),
    ]);

    for (const result of results) {
      assert.equal(result.durationSec, expectedDuration);
    }
  } finally {
    if (previousKey === undefined) {
      delete process.env.ELEVENLABS_API_KEY;
    } else {
      process.env.ELEVENLABS_API_KEY = previousKey;
    }
    globalThis.fetch = previousFetch;
  }
});
