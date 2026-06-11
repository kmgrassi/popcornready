import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCompleteAssetUpload,
  parseDirectAssetUpload,
} from "../schemas";
import { ApiError } from "@/core/errors";

test("parseDirectAssetUpload accepts a minimal direct upload request", () => {
  assert.deepEqual(
    parseDirectAssetUpload({
      filename: "clip.mp4",
      contentType: "video/mp4",
      sizeBytes: 1024,
    }),
    {
      filename: "clip.mp4",
      contentType: "video/mp4",
      sizeBytes: 1024,
      kind: "video",
      visibility: undefined,
      durationSec: undefined,
      context: undefined,
      userContext: undefined,
      agentContext: undefined,
    }
  );
});

test("parseDirectAssetUpload rejects unknown media without an explicit kind", () => {
  assert.throws(() => {
    try {
      parseDirectAssetUpload({
        filename: "asset.bin",
        contentType: "application/octet-stream",
        sizeBytes: 1024,
      });
    } catch (error) {
      assert.ok(error instanceof ApiError);
      assert.equal(error.details?.fields?.[0]?.path, "kind");
      throw error;
    }
  }, /request body is invalid/);
});

test("parseCompleteAssetUpload accepts multipart parts", () => {
  assert.deepEqual(
    parseCompleteAssetUpload({
      uploadId: "upload_1",
      parts: [
        { partNumber: 2, etag: '"etag-2"' },
        { partNumber: 1, etag: '"etag-1"' },
      ],
    }),
    {
      uploadId: "upload_1",
      parts: [
        { partNumber: 2, etag: '"etag-2"' },
        { partNumber: 1, etag: '"etag-1"' },
      ],
    }
  );
});
