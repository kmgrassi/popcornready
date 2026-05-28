import assert from "node:assert/strict";
import test from "node:test";
import { estimateMp3DurationSec, stripSpeechDirectives } from "../audio";

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
