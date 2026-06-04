import assert from "node:assert/strict";
import test from "node:test";

import { renderableAssetUrlFromRow, rowSourceToV1Source } from "../store";

test("Supabase asset rows preserve renderable remote URLs from shared columns", () => {
  assert.equal(
    renderableAssetUrlFromRow({
      url: null,
      remote_url: "https://cdn.example.com/clip.mp4",
      storage_key: null,
      source: { type: "remote_url", url: "https://cdn.example.com/source.mp4" },
    }),
    "https://cdn.example.com/source.mp4"
  );
});

test("Supabase asset rows preserve renderable storage keys when url is absent", () => {
  assert.equal(
    renderableAssetUrlFromRow({
      url: null,
      remote_url: null,
      storage_key: "media/uploads/ws_1/proj_1/asset_1.mp4",
      source: { type: "local_path", path: "/tmp/raw.mp4" },
    }),
    "media/uploads/ws_1/proj_1/asset_1.mp4"
  );
});

test("Supabase asset rows normalize structured source objects for lib/v1", () => {
  assert.equal(rowSourceToV1Source({ type: "remote_url" }), "remote_url");
  assert.equal(rowSourceToV1Source({ type: "generated", generatedAssetId: "asset_1" }), "generated");
  assert.equal(rowSourceToV1Source({ type: "multipart_upload" }), "upload");
});
