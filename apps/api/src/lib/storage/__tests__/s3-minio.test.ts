import assert from "node:assert/strict";
import test from "node:test";
import { readStorageConfig } from "../config";
import { createS3ObjectStore } from "../object-store";

const endpoint = process.env.AWS_ENDPOINT_URL_S3;

test("s3 store performs object operations against MinIO", { skip: !endpoint }, async () => {
  const config = readStorageConfig({
    ...process.env,
    STORAGE_BACKEND: "s3",
    AWS_REGION: process.env.AWS_REGION || "us-east-1",
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || "minioadmin",
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || "minioadmin",
    S3_PUBLIC_BUCKET: process.env.S3_PUBLIC_BUCKET || "assets-public",
    S3_PRIVATE_BUCKET: process.env.S3_PRIVATE_BUCKET || "assets-private",
    S3_PUBLIC_URL_BASE:
      process.env.S3_PUBLIC_URL_BASE ||
      `${endpoint}/${process.env.S3_PUBLIC_BUCKET || "assets-public"}`,
    S3_FORCE_PATH_STYLE: process.env.S3_FORCE_PATH_STYLE || "true",
  });
  const store = createS3ObjectStore(config);

  await store.ensureBucket("public");
  await store.ensureBucket("private");

  const key = `test/${Date.now()}/asset.txt`;
  await store.putObject({
    key,
    visibility: "public",
    body: "hello minio",
    contentType: "text/plain",
  });

  const stored = await store.getObject(key, "public");
  assert.equal(stored.body.toString("utf8"), "hello minio");
  assert.equal(stored.contentType, "text/plain");

  await store.copyObject({
    sourceKey: key,
    sourceVisibility: "public",
    destinationKey: key,
    destinationVisibility: "private",
  });
  assert.equal((await store.getObject(key, "private")).body.toString("utf8"), "hello minio");
  assert.match(await store.signedObjectUrl(key, "private", 60), /X-Amz-/);

  await store.deleteObject(key, "public");
  await store.deleteObject(key, "private");
});
