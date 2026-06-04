import assert from "node:assert/strict";
import test from "node:test";
import {
  parseUploadedFootageEditRequest,
  resolveUploadedFootageClips,
} from "../uploaded-footage";
import { Clip } from "@popcorn/shared/types";

const clips: Clip[] = [
  {
    id: "upload_a",
    filename: "upload-a.mp4",
    url: "/uploads/upload-a.mp4",
    kind: "video",
    durationSec: 8,
    description: "uploaded source",
    source: "upload",
  },
  {
    id: "generated_b",
    filename: "generated-b.mp4",
    url: "/uploads/generated-b.mp4",
    kind: "video",
    durationSec: 5,
    description: "generated source",
    source: "generated",
  },
  {
    id: "audio_c",
    filename: "audio-c.mp3",
    url: "/uploads/audio-c.mp3",
    kind: "audio",
    durationSec: 12,
    description: "music",
    source: "upload",
  },
];

test("uploaded-footage request defaults to uploaded-only editing", () => {
  const request = parseUploadedFootageEditRequest({});
  assert.equal(request.mode, "asset_driven");
  assert.equal(request.allowGeneratedGapFill, false);
  assert.deepEqual(request.assetIds, []);
});

test("hybrid mode enables generated gap fill intent", () => {
  const request = parseUploadedFootageEditRequest({
    mode: "hybrid",
    assetIds: ["upload_a", "upload_a", ""],
  });
  assert.equal(request.allowGeneratedGapFill, true);
  assert.deepEqual(request.assetIds, ["upload_a"]);
});

test("asset selection defaults to uploaded visual assets only", () => {
  const selected = resolveUploadedFootageClips(
    clips,
    parseUploadedFootageEditRequest({})
  );
  assert.deepEqual(
    selected.map((clip) => clip.id),
    ["upload_a"]
  );
});

test("explicit asset selection validates visual ids", () => {
  const request = parseUploadedFootageEditRequest({ assetIds: ["generated_b"] });
  assert.deepEqual(
    resolveUploadedFootageClips(clips, request).map((clip) => clip.id),
    ["generated_b"]
  );
  assert.throws(
    () =>
      resolveUploadedFootageClips(
        clips,
        parseUploadedFootageEditRequest({ assetIds: ["audio_c"] })
      ),
    /Selected asset not found/
  );
});
