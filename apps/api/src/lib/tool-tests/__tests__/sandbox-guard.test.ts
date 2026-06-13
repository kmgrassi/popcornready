import assert from "node:assert/strict";
import test from "node:test";

import { assertDeletableSandboxName, TEST_WORKSPACE_PREFIX } from "../sandbox-guard";

test("accepts a harness sandbox workspace name", () => {
  assert.doesNotThrow(() =>
    assertDeletableSandboxName(`${TEST_WORKSPACE_PREFIX}abc-123`)
  );
});

test("refuses the shared dev workspace name", () => {
  assert.throws(() => assertDeletableSandboxName("dev_workspace"), /Refusing to delete/);
});

test("refuses an empty or unprefixed name", () => {
  assert.throws(() => assertDeletableSandboxName(""), /Refusing to delete/);
  assert.throws(() => assertDeletableSandboxName("prod-workspace"), /Refusing to delete/);
});
