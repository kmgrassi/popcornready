import assert from "node:assert/strict";
import test from "node:test";
import {
  applyEditGraphRevisionOperations,
  compileEditGraphToTimeline,
  compileTimelineViaEditGraph,
  createEditGraphFromTimeline,
  ensureBeatIds,
  patchesToEditGraphOperations,
  synthesizeEditGraph,
} from "../edit-graph";
import { applyPatchesDirectly, applyPatchesViaEditGraph } from "../timeline";
import { Clip, EditPlan, Patch, Timeline } from "../types";

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

test("patches become ranked edit-graph operations before compilation", () => {
  const timeline: Timeline = {
    aspectRatio: "9:16",
    fps: 30,
    showCaptions: true,
    segments: [
      {
        id: "seg_1",
        clipId: "clip_a",
        sourceInSec: 0,
        sourceOutSec: 4,
        role: "hook",
        reason: "Open with the strongest visual.",
      },
      {
        id: "seg_2",
        clipId: "clip_b",
        sourceInSec: 1,
        sourceOutSec: 5,
        role: "proof",
        reason: "Show the result.",
      },
    ],
  };
  const patches: Patch[] = [
    {
      op: "set_trim",
      segmentId: "seg_1",
      sourceInSec: 0.5,
      sourceOutSec: 2.5,
      reason: "Tighten the hook.",
    },
    {
      op: "set_caption",
      segmentId: "seg_2",
      caption: "Here is the payoff",
      reason: "Clarify the result.",
    },
  ];

  const graph = createEditGraphFromTimeline(timeline, clips, plan);
  const operations = patchesToEditGraphOperations({ timeline, patches });
  const revisedGraph = applyEditGraphRevisionOperations({
    graph,
    operations,
    clips,
  });
  const revisedTimeline = compileEditGraphToTimeline(revisedGraph);

  assert.equal(operations[0].targetLayer, "edit");
  assert.equal(operations[0].alternatives.length, 2);
  assert.equal(operations[0].alternatives[0].score, 1);
  assert.equal(revisedTimeline.segments[0].sourceInSec, 0.5);
  assert.equal(revisedTimeline.segments[1].caption, "Here is the payoff");
  assert.equal(revisedGraph.edit.revisionOperations.length, 2);
});

test("applyPatches compatibility uses the edit graph compiler", () => {
  const timeline: Timeline = {
    aspectRatio: "9:16",
    fps: 30,
    segments: [
      {
        id: "seg_1",
        clipId: "clip_a",
        sourceInSec: 0,
        sourceOutSec: 4,
        role: "hook",
        reason: "Open with the strongest visual.",
      },
      {
        id: "seg_2",
        clipId: "clip_b",
        sourceInSec: 1,
        sourceOutSec: 5,
        role: "proof",
        reason: "Show the result.",
      },
    ],
  };
  const patches: Patch[] = [
    {
      op: "set_trim",
      segmentId: "seg_1",
      sourceInSec: 0.25,
      sourceOutSec: 3,
      reason: "Tighten the opening.",
    },
    { op: "remove_segment", segmentId: "seg_2", reason: "Remove the payoff." },
  ];

  const direct = applyPatchesDirectly(timeline, patches, clips);
  const viaGraph = applyPatchesViaEditGraph(timeline, patches, clips);

  assert.deepEqual(viaGraph.timeline, direct);
  assert.equal(viaGraph.editGraph.edit.decisions.length, 1);
  assert.equal(viaGraph.graphOperations.length, 2);
});

test("same-name beats get distinct ids and the graph links by beatId", () => {
  const dupPlan: EditPlan = {
    targetLengthSec: 6,
    style: "punchy",
    aspectRatio: "9:16",
    beats: [
      { name: "shot", durationSec: 3, intent: "first shot" },
      { name: "shot", durationSec: 3, intent: "second shot" },
    ],
  };
  ensureBeatIds(dupPlan);
  const [b0, b1] = dupPlan.beats;
  assert.ok(b0.id && b1.id && b0.id !== b1.id, "duplicate-name beats get distinct ids");

  const timeline: Timeline = {
    aspectRatio: "9:16",
    fps: 30,
    segments: [
      { id: "seg_1", clipId: "clip_a", sourceInSec: 0, sourceOutSec: 3, role: "shot", beatId: b0.id, reason: "first" },
      { id: "seg_2", clipId: "clip_b", sourceInSec: 0, sourceOutSec: 3, role: "shot", beatId: b1.id, reason: "second" },
    ],
  };
  const graph = synthesizeEditGraph({ id: "g", goal: "x", plan: dupPlan, timeline, clips });

  // Story beats keep the distinct minted ids...
  assert.deepEqual(graph.story.beats.map((b) => b.id), [b0.id, b1.id]);
  // ...and each decision links to its own beat by id, not collapsed by the
  // shared "shot" role (the bug stable ids fix).
  assert.deepEqual(graph.edit.decisions.map((d) => d.beatId), [b0.id, b1.id]);
});

test("legacy plans/segments without ids fall back to role-derived ids", () => {
  const legacyPlan: EditPlan = {
    targetLengthSec: 6,
    style: "p",
    aspectRatio: "9:16",
    beats: [
      { name: "hook", durationSec: 3, intent: "a" },
      { name: "proof", durationSec: 3, intent: "b" },
    ],
  };
  const timeline: Timeline = {
    aspectRatio: "9:16",
    fps: 30,
    segments: [
      { id: "seg_1", clipId: "clip_a", sourceInSec: 0, sourceOutSec: 3, role: "hook", reason: "" },
      { id: "seg_2", clipId: "clip_b", sourceInSec: 0, sourceOutSec: 3, role: "proof", reason: "" },
    ],
  };
  const graph = synthesizeEditGraph({ id: "g", goal: "x", plan: legacyPlan, timeline, clips });

  assert.deepEqual(graph.story.beats.map((b) => b.id), ["beat_1_hook", "beat_2_proof"]);
  assert.deepEqual(graph.edit.decisions.map((d) => d.beatId), ["beat_1_hook", "beat_2_proof"]);
});
