import assert from "node:assert/strict";
import test from "node:test";
import {
  compileEditGraphToTimeline,
  compileTimelineViaEditGraph,
  synthesizeEditGraph,
} from "../edit-graph";
import { Clip, EditPlan, Timeline } from "../types";

const plan: EditPlan = {
  targetLengthSec: 7,
  style: "punchy",
  aspectRatio: "9:16",
  beats: [
    { name: "hook", durationSec: 3, intent: "open on the strongest moment" },
    { name: "proof", durationSec: 4, intent: "show the product working" },
  ],
};

const clips: Clip[] = [
  {
    id: "clip_a",
    filename: "a.mp4",
    url: "/uploads/a.mp4",
    durationSec: 5,
    description: "strong opener",
  },
  {
    id: "clip_b",
    filename: "b.mp4",
    url: "/uploads/b.mp4",
    durationSec: 6,
    description: "product proof",
  },
];

test("synthesized edit graph compiles back to today's timeline byte-for-byte", () => {
  const timeline: Timeline = {
    aspectRatio: "9:16",
    fps: 30,
    segments: [
      {
        id: "seg_1",
        clipId: "clip_a",
        sourceInSec: 0.25,
        sourceOutSec: 2.75,
        role: "hook",
        reason: "best visual hook",
        caption: "Watch this",
      },
      {
        id: "seg_2",
        clipId: "clip_b",
        sourceInSec: 1,
        sourceOutSec: 5,
        role: "proof",
        reason: "demonstrates the claim",
      },
    ],
    showCaptions: true,
  };

  const graph = synthesizeEditGraph({
    id: "graph_1",
    goal: "make a short product demo",
    plan,
    timeline,
    clips,
  });

  assert.equal(
    JSON.stringify(compileEditGraphToTimeline(graph)),
    JSON.stringify(timeline)
  );
});

test("compiler preserves pre-sanitize planner output without segment ids", () => {
  const timeline = {
    aspectRatio: "9:16",
    fps: 30,
    segments: [
      {
        clipId: "clip_a",
        sourceInSec: 0,
        sourceOutSec: 3,
        role: "hook",
        reason: "matches the first beat",
      },
    ],
  } as Timeline;

  assert.equal(
    JSON.stringify(
      compileTimelineViaEditGraph({
        id: "graph_raw",
        goal: "make a short product demo",
        plan,
        timeline,
        clips,
      })
    ),
    JSON.stringify(timeline)
  );
});

test("compiler preserves segment roles that do not match a plan beat", () => {
  const timeline: Timeline = {
    aspectRatio: "9:16",
    fps: 30,
    segments: [
      {
        id: "seg_1",
        clipId: "clip_a",
        sourceInSec: 0,
        sourceOutSec: 3,
        role: "product close-up",
        reason: "descriptive role with no matching beat",
      },
    ],
  };

  assert.equal(
    JSON.stringify(
      compileTimelineViaEditGraph({
        id: "graph_unmatched",
        goal: "make a short product demo",
        plan,
        timeline,
        clips,
      })
    ),
    JSON.stringify(timeline)
  );
});

test("compiler is pure and does not mutate the source graph", () => {
  const timeline: Timeline = {
    aspectRatio: "9:16",
    fps: 30,
    segments: [
      {
        id: "seg_1",
        clipId: "clip_a",
        sourceInSec: 0,
        sourceOutSec: 3,
        role: "hook",
        reason: "matches the first beat",
      },
    ],
  };
  const graph = synthesizeEditGraph({
    id: "graph_pure",
    goal: "make a short product demo",
    plan,
    timeline,
    clips,
  });
  const before = JSON.stringify(graph);

  compileEditGraphToTimeline(graph);

  assert.equal(JSON.stringify(graph), before);
});
