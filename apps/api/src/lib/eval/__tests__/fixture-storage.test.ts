import assert from "node:assert/strict";
import test from "node:test";

import {
  EVAL_BUCKET,
  evalFixtureObjectPath,
  evalFixtureTextArtifact,
  isDuplicateObjectError,
  sha256Bytes,
} from "../fixture-storage";

test("eval fixture media uses sha256-derived object keys", () => {
  const bytes = Buffer.from("fixture-media");
  const sha256 = sha256Bytes(bytes);

  assert.equal(
    evalFixtureObjectPath({ sha256, filename: "clip.MP4" }),
    `${sha256}.mp4`
  );
});

test("eval fixture media falls back to content type extension", () => {
  const sha256 = sha256Bytes(Buffer.from("fixture-media"));

  assert.equal(
    evalFixtureObjectPath({ sha256, contentType: "image/png" }),
    `${sha256}.png`
  );
});

test("eval fixture text artifacts stay inline", () => {
  assert.deepEqual(evalFixtureTextArtifact({ plan: "three acts" }), {
    kind: "text",
    artifact: { plan: "three acts" },
  });
});

test("eval bucket id matches the scoped storage decision", () => {
  assert.equal(EVAL_BUCKET, "eval");
});

test("duplicate fixture uploads are treated as idempotent", () => {
  assert.equal(isDuplicateObjectError({ statusCode: 409 }), true);
  assert.equal(
    isDuplicateObjectError({ message: "The resource already exists" }),
    true
  );
  assert.equal(isDuplicateObjectError({ statusCode: 500, message: "boom" }), false);
});
