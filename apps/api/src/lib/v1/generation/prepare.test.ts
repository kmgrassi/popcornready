import assert from "node:assert/strict";
import test from "node:test";

import { briefToStoryContext } from "./prepare";

test("briefToStoryContext maps advanced brief direction into story context", () => {
  const context = briefToStoryContext({
    goal: "Make a launch teaser.",
    targetLengthSec: 60,
    aspectRatio: "16:9",
    audience: "founders",
    platform: "youtube",
    format: "visual_reveal",
    hookQuestion: "What changed?",
    strongestVisual: "A live product demo.",
    oneBigIdea: "The agent plans the cut before rendering.",
    caveat: "Do not claim raw video editing.",
    payoff: "The viewer understands the guided rough-cut flow.",
    constraints: {
      callToAction: "Start a rough cut.",
    },
  });

  assert.equal(context.audience, "founders");
  assert.equal(context.platform, "youtube");
  assert.equal(context.format, "visual_reveal");
  assert.equal(context.hookQuestion, "What changed?");
  assert.equal(context.strongestVisual, "A live product demo.");
  assert.equal(context.oneBigIdea, "The agent plans the cut before rendering.");
  assert.equal(context.caveat, "Do not claim raw video editing.");
  assert.equal(context.payoff, "The viewer understands the guided rough-cut flow.");
  assert.equal(context.callToAction, "Start a rough cut.");
});
