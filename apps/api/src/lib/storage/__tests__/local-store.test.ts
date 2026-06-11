import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readStorageConfig } from "../config";
import { createLocalObjectStore } from "../local-store";

test("local store puts, gets, copies, deletes, and returns local media URLs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "popcorn-storage-"));
  const config = readStorageConfig({
    STORAGE_BACKEND: "local",
    STORAGE_LOCAL_DIR: root,
    S3_PUBLIC_BUCKET: "assets-public",
    S3_PRIVATE_BUCKET: "assets-private",
  });
  const store = createLocalObjectStore(config);

  await store.ensureBucket("public");
  const put = await store.putObject({
    key: "ws/proj/asset/source.txt",
    body: "hello storage",
    visibility: "public",
    contentType: "text/plain",
  });

  assert.deepEqual(put, {
    bucket: "assets-public",
    key: "ws/proj/asset/source.txt",
  });
  assert.equal(
    store.objectUrl(put.key, "public"),
    "/media/assets-public/ws/proj/asset/source.txt"
  );

  const stored = await store.getObject(put.key, "public");
  assert.equal(stored.body.toString("utf8"), "hello storage");
  assert.equal(stored.contentType, "text/plain");

  const copied = await store.copyObject({
    sourceKey: put.key,
    sourceVisibility: "public",
    destinationKey: "ws/proj/asset/copy.txt",
    destinationVisibility: "private",
  });
  assert.equal(copied.bucket, "assets-private");

  const privateCopy = await store.getObject(copied.key, "private");
  assert.equal(privateCopy.body.toString("utf8"), "hello storage");
  assert.equal(privateCopy.contentType, "text/plain");

  await store.deleteObject(put.key, "public");
  await assert.rejects(() => store.getObject(put.key, "public"));
});

test("local signed URLs intentionally fall back to the unsigned local media path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "popcorn-storage-"));
  const store = createLocalObjectStore(
    readStorageConfig({
      STORAGE_BACKEND: "local",
      STORAGE_LOCAL_DIR: root,
    })
  );

  assert.equal(
    await store.signedObjectUrl("ws/proj/asset/private.mp4", "private"),
    "/media/assets-private/ws/proj/asset/private.mp4"
  );
});
