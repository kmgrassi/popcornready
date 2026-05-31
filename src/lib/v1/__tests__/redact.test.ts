import assert from "node:assert/strict";
import test from "node:test";

import { ApiError } from "../errors";
import { redactError, redactMessage } from "../redact";

test("scrubs OpenAI-shaped secret keys", () => {
  const message = "OpenAI request failed (401): bad sk-AbCdEfGhIjKlMnOpQrStUvWxYz1234567890 token";
  const out = redactMessage(message);
  assert.match(out, /\[REDACTED\]/);
  assert.doesNotMatch(out, /sk-AbCdEfGh/);
});

test("scrubs Bearer tokens", () => {
  const message = "401 unauthorized: Authorization: Bearer abcdef1234567890abcdef1234 fail";
  const out = redactMessage(message);
  assert.doesNotMatch(out, /abcdef1234567890abcdef1234/);
});

test("scrubs key=value style secrets", () => {
  const message = `error body: {"api_key":"shouldnotleakthisvalue123","other":"ok"}`;
  const out = redactMessage(message);
  assert.match(out, /\[REDACTED\]/);
  assert.doesNotMatch(out, /shouldnotleakthisvalue123/);
  assert.match(out, /"other":"ok"/);
});

test("scrubs xi-api-key header style", () => {
  const message = "ElevenLabs request failed (401): xi-api-key=elv_live_supersecret12345 invalid";
  const out = redactMessage(message);
  assert.doesNotMatch(out, /elv_live_supersecret12345/);
});

test("scrubs JWT-shaped tokens", () => {
  const message =
    "JWT verify failed: eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoidGVzdCJ9.signaturebytes123 not allowed";
  const out = redactMessage(message);
  assert.doesNotMatch(out, /eyJhbGciOiJIUzI1NiJ9/);
});

test("truncates long messages", () => {
  const long = "x".repeat(2000);
  const out = redactMessage(long, 100);
  assert.ok(out.length <= 100, `expected <= 100 chars, got ${out.length}`);
});

test("redactError on Error keeps code from the Error when present", () => {
  const err = new ApiError("asset_invalid", "Asset key sk-abcdefghijklmnopqrstuvwxyz");
  const out = redactError(err);
  assert.equal(out.code, "asset_invalid");
  assert.doesNotMatch(out.message, /sk-abcdef/);
});

test("redactError on plain Error uses default code", () => {
  const err = new Error("something blew up");
  const out = redactError(err, { defaultCode: "model_output_invalid" });
  assert.equal(out.code, "model_output_invalid");
  assert.equal(out.message, "something blew up");
});

test("redactError on string falls through scrubbing", () => {
  const out = redactError("token sk-AbCdEfGhIjKlMnOpQrStUvWxYz1234567890 leaked");
  assert.equal(out.code, "internal_error");
  assert.doesNotMatch(out.message, /sk-AbCdEfGh/);
});

test("redactError on unknown value still returns safe shape", () => {
  const out = redactError(null);
  assert.equal(typeof out.code, "string");
  assert.equal(typeof out.message, "string");
});
