import assert from "node:assert/strict";
import test from "node:test";

import { assetStorageKey } from "../uploads";
import { readStorageConfig, storageBucketForVisibility } from "../config";

test("assetStorageKey scopes browser uploads by workspace, project, and asset", () => {
  assert.equal(
    assetStorageKey({
      workspaceId: "ws_1",
      projectId: "proj_1",
      assetId: "asset_1",
      filename: "../raw launch!.mp4",
    }),
    "ws_1/proj_1/asset_1/raw launch_.mp4"
  );
});

test("storageBucketForVisibility maps effective visibility to delivery buckets", () => {
  assert.equal(storageBucketForVisibility("public"), "assets-public");
  assert.equal(storageBucketForVisibility("private"), "assets-private");
});

test("readStorageConfig defaults direct uploads to the dark local backend", () => {
  const config = readStorageConfig({});
  assert.equal(config.backend, "local");
  assert.equal(config.publicBucket, "assets-public");
  assert.equal(config.privateBucket, "assets-private");
  assert.equal(config.multipartThresholdBytes, 100 * 1024 * 1024);
});
