import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiError } from "../errors";
import {
  parseBeatInput,
  parsePanelInput,
  parseSceneInput,
  parseStoryboardInput,
} from "../storyboards";

test("storyboard parsers preserve null clears and valid statuses", () => {
  assert.deepEqual(parseStoryboardInput({ planAssetId: null, status: "ready" }), {
    planAssetId: null,
    status: "ready",
  });
  assert.deepEqual(parseSceneInput({ sceneIndex: 1, title: null, status: "draft" }), {
    sceneIndex: 1,
    title: null,
    summary: undefined,
    setting: undefined,
    mood: undefined,
    durationSec: undefined,
    sceneAssetId: undefined,
    status: "draft",
  });
  assert.deepEqual(parseBeatInput({ intent: "Open on the hero", durationSec: null }), {
    beatIndex: undefined,
    intent: "Open on the hero",
    visualDescription: undefined,
    dialogueSummary: undefined,
    narration: undefined,
    durationSec: null,
    status: undefined,
    beatAssetId: undefined,
  });
  assert.deepEqual(parsePanelInput({ isSelected: true, approvedAt: null }), {
    panelIndex: undefined,
    imageAssetId: undefined,
    promptAssetId: undefined,
    status: undefined,
    isSelected: true,
    approvedAt: null,
  });
});

test("storyboard parsers reject invalid request shapes", () => {
  assert.throws(
    () => parseStoryboardInput(null),
    (err) => err instanceof ApiError && err.code === "validation_failed"
  );
  assert.throws(
    () => parseSceneInput({ sceneIndex: -1 }),
    (err) => err instanceof ApiError && err.code === "validation_failed"
  );
  assert.throws(
    () => parseBeatInput({ status: "done" }),
    (err) => err instanceof ApiError && err.code === "validation_failed"
  );
  assert.throws(
    () => parseBeatInput({ intent: null }),
    (err) => err instanceof ApiError && err.code === "validation_failed"
  );
  assert.throws(
    () => parsePanelInput({ isSelected: "true" }),
    (err) => err instanceof ApiError && err.code === "validation_failed"
  );
});
