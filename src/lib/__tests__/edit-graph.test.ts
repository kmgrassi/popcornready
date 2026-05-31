import assert from "node:assert/strict";
import test from "node:test";

import {
  applyEditGraphRevisionOperations,
  compileEditGraph,
  createEditGraphFromTimeline,
  patchesToEditGraphOperations,
} from "../edit-graph";
import { applyPatches, applyPatchesViaEditGraph } from "../timeline";
import { Clip, Patch, Timeline } from "../types";

const clips: Clip[] = [
  {
    id: "clip_a",
    filename: "a.mp4",
    url: "/uploads/a.mp4",
    kind: "video",
    durationSec: 10,
    description: "",
  },
  {
    id: "clip_b",
    filename: "b.mp4",
    url: "/uploads/b.mp4",
    kind: "video",
    durationSec: 8,
    description: "",
  },
];

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
      role: "payoff",
      reason: "Show the result.",
    },
  ],
};

test("timeline lifts into an edit graph and compiles back unchanged", () => {
  const graph = createEditGraphFromTimeline(timeline);
  assert.equal(graph.schemaVersion, "edit-graph.v1");
  assert.equal(graph.edit.decisions[0].beatId, "hook");
  assert.deepEqual(compileEditGraph(graph), timeline);
});

test("patches become ranked edit-graph operations before compilation", () => {
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

  const graph = createEditGraphFromTimeline(timeline);
  const operations = patchesToEditGraphOperations({ timeline, patches });
  const revisedGraph = applyEditGraphRevisionOperations({
    graph,
    operations,
    clips,
  });
  const revisedTimeline = compileEditGraph(revisedGraph);

  assert.equal(operations[0].targetLayer, "edit");
  assert.equal(operations[0].alternatives.length, 2);
  assert.equal(operations[0].alternatives[0].score, 1);
  assert.equal(revisedTimeline.segments[0].sourceInSec, 0.5);
  assert.equal(revisedTimeline.segments[1].caption, "Here is the payoff");
  assert.equal(revisedGraph.edit.revisionOperations.length, 2);
});

test("applyPatches compatibility uses the edit graph compiler", () => {
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

  const direct = applyPatches(timeline, patches, clips);
  const viaGraph = applyPatchesViaEditGraph(timeline, patches, clips);

  assert.deepEqual(viaGraph.timeline, direct);
  assert.equal(viaGraph.editGraph.edit.decisions.length, 1);
  assert.equal(viaGraph.graphOperations.length, 2);
});

