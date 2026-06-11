import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assetStorageKey,
  contentTypeForFilename,
  writeAssetObject,
} from "./asset-write";
import type { ObjectStore } from "./object-store";
import { withLocalDir } from "@/lib/api/v1/store";

test("assetStorageKey uses workspace/project/asset/filename", () => {
  assert.equal(
    assetStorageKey({
      workspaceId: "ws_1",
      projectId: "proj_1",
      assetId: "asset_1",
      filename: "../clip.mp4",
    }),
    "ws_1/proj_1/asset_1/clip.mp4"
  );
});

test("contentTypeForFilename prefers explicit type and falls back by extension", () => {
  assert.equal(contentTypeForFilename("poster.png"), "image/png");
  assert.equal(contentTypeForFilename("clip.unknown"), "application/octet-stream");
  assert.equal(contentTypeForFilename("clip.mp4", "video/custom"), "video/custom");
});

test("writeAssetObject stores local backend bytes at the storage key", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "popcornready-storage-"));
  try {
    const store = mockObjectStore();
    const result = await withLocalDir(tmpDir, () =>
      writeAssetObject({
        workspaceId: "ws_1",
        projectId: "proj_1",
        assetId: "asset_1",
        filename: "clip.mp4",
        bytes: Buffer.from("video-bytes"),
        visibility: "public",
        store,
      })
    );

    assert.equal(store.puts.length, 1);
    assert.equal(result.storageKey, "ws_1/proj_1/asset_1/clip.mp4");
    assert.equal(result.storageBucket, "assets-public");
    assert.equal(result.contentType, "video/mp4");
    assert.equal(
      await fs.readFile(path.join(tmpDir, result.storageKey), "utf8"),
      "video-bytes"
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("writeAssetObject keeps a compatibility local cache for object-store writes", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "popcornready-storage-"));
  try {
    const store = mockObjectStore();
    const result = await withLocalDir(tmpDir, () =>
      writeAssetObject({
        workspaceId: "ws_1",
        projectId: "proj_1",
        assetId: "asset_1",
        filename: "clip.mp4",
        bytes: Buffer.from("video-bytes"),
        visibility: "private",
        store,
      })
    );

    assert.equal(store.puts.length, 1);
    assert.equal(result.storageBucket, "assets-private");
    assert.equal(
      await fs.readFile(path.join(tmpDir, result.storageKey), "utf8"),
      "video-bytes"
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

function mockObjectStore(): ObjectStore & { puts: ObjectStorePut[] } {
  const puts: ObjectStorePut[] = [];
  return {
    puts,
    async putObject(input) {
      puts.push(input);
      return {
        bucket: input.visibility === "public" ? "assets-public" : "assets-private",
        key: input.key,
      };
    },
    async getObject() {
      return { body: Buffer.alloc(0) };
    },
    async copyObject(input) {
      return {
        bucket: input.destinationVisibility === "public" ? "assets-public" : "assets-private",
        key: input.destinationKey,
      };
    },
    async deleteObject() {},
    objectUrl(key) {
      return `/media/${key}`;
    },
    async signedObjectUrl(key) {
      return `/media/${key}`;
    },
    async ensureBucket() {},
  };
}

type ObjectStorePut = Parameters<ObjectStore["putObject"]>[0];
