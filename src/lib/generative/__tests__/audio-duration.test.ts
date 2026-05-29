import assert from "node:assert/strict";
import test from "node:test";
import { measureAudioDurationSec } from "../audio-duration";

// One MPEG-1 Layer III frame at 128 kbps / 44100 Hz: header 0xFF 0xFB 0x90 0x00,
// frame length 417 bytes, 1152 samples => 1152/44100 s of audio.
const MP3_FRAME_BYTES = 417;
const MP3_FRAME_SEC = 1152 / 44100;

function mp3Frame(): Buffer {
  const frame = Buffer.alloc(MP3_FRAME_BYTES);
  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = 0x90;
  frame[3] = 0x00;
  return frame;
}

function mp3Buffer(frames: number): Buffer {
  return Buffer.concat(Array.from({ length: frames }, mp3Frame));
}

// One MPEG-2 Layer III frame at 32 kbps / 22050 Hz (e.g. ElevenLabs
// mp3_22050_32): header 0xFF 0xF3 0x40 0x00, frame length 104 bytes, 576
// samples => 576/22050 s of audio.
const MP3V2_FRAME_BYTES = 104;
const MP3V2_FRAME_SEC = 576 / 22050;

function mp3V2Frame(): Buffer {
  const frame = Buffer.alloc(MP3V2_FRAME_BYTES);
  frame[0] = 0xff;
  frame[1] = 0xf3;
  frame[2] = 0x40;
  frame[3] = 0x00;
  return frame;
}

function mp3V2Buffer(frames: number): Buffer {
  return Buffer.concat(Array.from({ length: frames }, mp3V2Frame));
}

function id3v2Header(tagBytes: number): Buffer {
  const header = Buffer.alloc(10);
  header.write("ID3", 0, "ascii");
  header[3] = 3; // version
  header[4] = 0;
  header[5] = 0; // flags
  header[6] = (tagBytes >> 21) & 0x7f;
  header[7] = (tagBytes >> 14) & 0x7f;
  header[8] = (tagBytes >> 7) & 0x7f;
  header[9] = tagBytes & 0x7f;
  return Buffer.concat([header, Buffer.alloc(tagBytes)]);
}

function wavBuffer(seconds: number): Buffer {
  const channels = 2;
  const sampleRate = 44100;
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8); // 176400
  const dataSize = Math.round(byteRate * seconds);

  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * (bitsPerSample / 8), 32); // block align
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, Buffer.alloc(dataSize)]);
}

test("measures MP3 duration by summing frame headers", () => {
  const measured = measureAudioDurationSec(mp3Buffer(100), "mp3");
  assert.ok(measured !== null);
  assert.ok(Math.abs(measured! - 100 * MP3_FRAME_SEC) < 1e-6);
});

test("measures MPEG-2 Layer III (low sample rate) MP3 duration", () => {
  const measured = measureAudioDurationSec(mp3V2Buffer(80), "mp3");
  assert.ok(measured !== null);
  assert.ok(Math.abs(measured! - 80 * MP3V2_FRAME_SEC) < 1e-6);
});

test("skips an ID3v2 tag before parsing MP3 frames", () => {
  const buf = Buffer.concat([id3v2Header(40), mp3Buffer(50)]);
  const measured = measureAudioDurationSec(buf, "mp3");
  assert.ok(measured !== null);
  assert.ok(Math.abs(measured! - 50 * MP3_FRAME_SEC) < 1e-6);
});

test("measures WAV duration from the byte rate and data chunk size", () => {
  const measured = measureAudioDurationSec(wavBuffer(2.5), "wav");
  assert.ok(measured !== null);
  assert.ok(Math.abs(measured! - 2.5) < 1e-3);
});

test("sniffs WAV by header even when the extension says mp3", () => {
  const measured = measureAudioDurationSec(wavBuffer(1), "mp3");
  assert.ok(measured !== null);
  assert.ok(Math.abs(measured! - 1) < 1e-3);
});

test("returns null for empty buffers and undecodable formats", () => {
  assert.equal(measureAudioDurationSec(Buffer.alloc(0), "mp3"), null);
  assert.equal(measureAudioDurationSec(Buffer.from("not audio"), "opus"), null);
});
