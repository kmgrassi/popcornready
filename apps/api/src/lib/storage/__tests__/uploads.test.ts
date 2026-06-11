import assert from "node:assert/strict";
import test from "node:test";

import { assetStorageKey } from "../uploads";
import { readStorageConfig, storageBucketForVisibility } from "../config";
import { resolveAssetUrlForGeneration } from "../asset-urls";

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

test("resolveAssetUrlForGeneration preserves local storage-key URLs", async () => {
  const previous = process.env.STORAGE_BACKEND;
  process.env.STORAGE_BACKEND = "local";
  try {
    assert.equal(
      await resolveAssetUrlForGeneration({
        id: "asset_1",
        filename: "clip.mp4",
        storageKey: "media/uploads/ws_1/proj_1/clip.mp4",
      }),
      "/uploads/ws_1/proj_1/clip.mp4"
    );
  } finally {
    if (previous === undefined) delete process.env.STORAGE_BACKEND;
    else process.env.STORAGE_BACKEND = previous;
  }
});

test("resolveAssetUrlForGeneration uses the public base for public S3 assets", async () => {
  const previousBackend = process.env.STORAGE_BACKEND;
  const previousBase = process.env.S3_PUBLIC_URL_BASE;
  process.env.STORAGE_BACKEND = "s3";
  process.env.S3_PUBLIC_URL_BASE = "https://cdn.example.com/";
  try {
    assert.equal(
      await resolveAssetUrlForGeneration({
        id: "asset_1",
        filename: "launch clip.mp4",
        storageKey: "ws_1/proj_1/asset_1/launch clip.mp4",
        storageBucket: "assets-public",
      }),
      "https://cdn.example.com/ws_1/proj_1/asset_1/launch%20clip.mp4"
    );
  } finally {
    if (previousBackend === undefined) delete process.env.STORAGE_BACKEND;
    else process.env.STORAGE_BACKEND = previousBackend;
    if (previousBase === undefined) delete process.env.S3_PUBLIC_URL_BASE;
    else process.env.S3_PUBLIC_URL_BASE = previousBase;
  }
});
