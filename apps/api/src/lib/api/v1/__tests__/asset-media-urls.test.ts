import assert from "node:assert/strict";
import test from "node:test";

import { assetMediaUrlsForRow } from "../store";

const fixedNow = () => new Date("2026-06-11T12:00:00.000Z");

test("assetMediaUrlsForRow reuses image URLs as thumbnails", async () => {
  const media = await assetMediaUrlsForRow(
    {
      media: "image",
      kind: "keyframe",
      status: "ready",
      remote_url: "https://cdn.example/keyframe.png",
      storage_key: null,
    },
    { now: fixedNow }
  );

  assert.equal(media.url, "https://cdn.example/keyframe.png");
  assert.equal(media.thumbnailUrl, media.url);
  assert.equal(media.expiresAt, "2026-06-11T13:00:00.000Z");
});

test("assetMediaUrlsForRow falls back to a local static URL for legacy local storage keys", async () => {
  const media = await assetMediaUrlsForRow(
    {
      media: "video",
      kind: "clip",
      status: "ready",
      remote_url: null,
      storage_key: "media/uploads/ws1/p1/dev-only.mp4",
    },
    { now: fixedNow }
  );

  assert.equal(media.url, "/uploads/ws1/p1/dev-only.mp4");
  assert.equal(media.thumbnailUrl, null);
  assert.equal(media.expiresAt, "2026-06-11T13:00:00.000Z");
});

test("assetMediaUrlsForRow keeps remote URLs ahead of non-local storage keys", async () => {
  const media = await assetMediaUrlsForRow(
    {
      media: "video",
      kind: "clip",
      status: "ready",
      remote_url: "https://cdn.example/clip.mp4",
      storage_key: "uploads/ws1/p1/missing.mp4",
    },
    { now: fixedNow }
  );

  assert.equal(media.url, "https://cdn.example/clip.mp4");
  assert.equal(media.thumbnailUrl, null);
  assert.equal(media.expiresAt, "2026-06-11T13:00:00.000Z");
});

test("assetMediaUrlsForRow withholds URLs for pending and data assets", async () => {
  const pending = await assetMediaUrlsForRow(
    {
      media: "audio",
      kind: "audio_track",
      status: "pending",
      remote_url: "https://cdn.example/audio.mp3",
      storage_key: null,
    },
    { now: fixedNow }
  );
  const data = await assetMediaUrlsForRow(
    {
      media: "data",
      kind: "plan",
      status: "ready",
      remote_url: "https://cdn.example/story.json",
      storage_key: null,
    },
    { now: fixedNow }
  );

  assert.deepEqual(pending, {
    url: null,
    thumbnailUrl: null,
    expiresAt: "2026-06-11T13:00:00.000Z",
  });
  assert.deepEqual(data, {
    url: null,
    thumbnailUrl: null,
    expiresAt: "2026-06-11T13:00:00.000Z",
  });
});
