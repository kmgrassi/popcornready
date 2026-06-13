import assert from "node:assert/strict";
import test from "node:test";

import { normalizeStatuses, subsetMismatches } from "../assertions";

test("subsetMismatches passes when actual contains the expected subset", () => {
  const actual = { aspectRatio: "9:16", goal: "x", extra: 1 };
  assert.deepEqual(subsetMismatches(actual, { aspectRatio: "9:16" }), []);
});

test("subsetMismatches reports a wrong primitive value", () => {
  const mismatches = subsetMismatches({ aspectRatio: "16:9" }, { aspectRatio: "9:16" });
  assert.equal(mismatches.length, 1);
  assert.match(mismatches[0], /aspectRatio/);
});

test("subsetMismatches reports a missing key", () => {
  const mismatches = subsetMismatches({ goal: "x" }, { aspectRatio: "9:16" });
  assert.equal(mismatches.length, 1);
  assert.match(mismatches[0], /missing/);
});

test("subsetMismatches recurses into nested objects", () => {
  const actual = { plan: { aspectRatio: "9:16", scenes: [1, 2] } };
  assert.deepEqual(subsetMismatches(actual, { plan: { aspectRatio: "9:16" } }), []);
  const bad = subsetMismatches(actual, { plan: { aspectRatio: "1:1" } });
  assert.equal(bad.length, 1);
  assert.match(bad[0], /plan\.aspectRatio/);
});

test("subsetMismatches checks array length and elements", () => {
  assert.deepEqual(subsetMismatches({ a: [1, 2] }, { a: [1, 2] }), []);
  assert.equal(subsetMismatches({ a: [1] }, { a: [1, 2] }).length, 1);
  assert.equal(subsetMismatches({ a: [1, 3] }, { a: [1, 2] }).length, 1);
});

test("normalizeStatuses accepts a single status or an array", () => {
  assert.deepEqual(normalizeStatuses("succeeded"), ["succeeded"]);
  assert.deepEqual(normalizeStatuses(["succeeded", "failed"]), ["succeeded", "failed"]);
});
