import assert from "node:assert/strict";
import test from "node:test";
import { readStorageConfig, resolveBucket, StorageConfigError } from "../config";

test("storage config defaults to local disk media storage", () => {
  const config = readStorageConfig({
    POPCORN_READY_LOCAL_DIR: "/tmp/popcorn-local",
  });

  assert.equal(config.backend, "local");
  assert.equal(config.localMediaDir, "/tmp/popcorn-local/media");
  assert.equal(config.publicBucket, "assets-public");
  assert.equal(config.privateBucket, "assets-private");
});

test("s3 config reads MinIO endpoint and path-style options", () => {
  const config = readStorageConfig({
    STORAGE_BACKEND: "s3",
    AWS_REGION: "us-east-1",
    AWS_ENDPOINT_URL_S3: "http://localhost:9000",
    S3_FORCE_PATH_STYLE: "true",
    AWS_ACCESS_KEY_ID: "minioadmin",
    AWS_SECRET_ACCESS_KEY: "minioadmin",
    S3_PUBLIC_BUCKET: "assets-public-test",
    S3_PRIVATE_BUCKET: "assets-private-test",
    S3_PUBLIC_URL_BASE: "http://localhost:9000/assets-public-test/",
  });

  assert.equal(config.backend, "s3");
  assert.equal(config.s3EndpointUrl, "http://localhost:9000");
  assert.equal(config.forcePathStyle, true);
  assert.equal(config.publicUrlBase, "http://localhost:9000/assets-public-test");
  assert.equal(resolveBucket(config, "public"), "assets-public-test");
  assert.equal(resolveBucket(config, "private"), "assets-private-test");
});

test("s3 config validates required delivery settings", () => {
  assert.throws(
    () => readStorageConfig({ STORAGE_BACKEND: "s3" }),
    (error) =>
      error instanceof StorageConfigError &&
      error.message.includes("S3_PUBLIC_URL_BASE")
  );
});
