import assert from "node:assert/strict";
import test from "node:test";
import {
  compileEditGraphToTimeline,
  editGraphForGeneratedBeatClips,
  editGraphFromTimeline,
  storyPlanFromEditPlan,
} from "../edit-graph";
import { Clip, EditPlan, Timeline } from "../types";

const plan: EditPlan = {
  targetLengthSec: 8,
  style: "punchy explainer",
  aspectRatio: "9:16",
  beats: [
    { name: "hook", durationSec: 3, intent: "Open with the surprising fact." },
    { name: "proof", durationSec: 5, intent: "Show the visual evidence." },
  ],
};

const clips: Clip[] = [
  {
    id: "clip_a",
    filename: "a.mp4",
    url: "/uploads/a.mp4",
    durationSec: 3,
    description: "surprising opener",
  },
  {
    id: "clip_b",
    filename: "b.mp4",
    url: "/uploads/b.mp4",
    durationSec: 5,
    description: "proof shot",
  },
];

test("storyPlanFromEditPlan lifts beats and story context into graph story", () => {
  const story = storyPlanFromEditPlan({
    goal: "Explain tides",
    plan,
    storyContext: { audience: "students" },
  });

  assert.equal(story.objective, "Explain tides");
  assert.equal(story.audience, "students");
  assert.equal(story.targetDurationMs, 8000);
  assert.deepEqual(
    story.beats.map((beat) => [beat.id, beat.role, beat.targetDurationMs]),
    [
      ["beat_1_hook", "hook", 3000],
      ["beat_2_proof", "evidence", 5000],
    ]
  );
});

test("generated beat clips become edit decisions and compile to timeline segments", () => {
  const graph = editGraphForGeneratedBeatClips({
    goal: "Explain tides",
    plan,
    clips,
  });
  const timeline = compileEditGraphToTimeline({
    graph,
    aspectRatio: "9:16",
    fps: 30,
  });

  assert.equal(graph.schemaVersion, "edit-graph.v1");
  assert.deepEqual(
    graph.decisions.map((decision) => ({
      beatId: decision.beatId,
      sourceClipId: decision.sourceClipId,
      rationale: decision.rationale,
    })),
    [
      {
        beatId: "beat_1_hook",
        sourceClipId: "clip_a",
        rationale: "Open with the surprising fact.",
      },
      {
        beatId: "beat_2_proof",
        sourceClipId: "clip_b",
        rationale: "Show the visual evidence.",
      },
    ]
  );
  assert.deepEqual(
    timeline.segments.map((segment) => ({
      clipId: segment.clipId,
      sourceInSec: segment.sourceInSec,
      sourceOutSec: segment.sourceOutSec,
      role: segment.role,
      reason: segment.reason,
    })),
    [
      {
        clipId: "clip_a",
        sourceInSec: 0,
        sourceOutSec: 3,
        role: "hook",
        reason: "Open with the surprising fact.",
      },
      {
        clipId: "clip_b",
        sourceInSec: 0,
        sourceOutSec: 5,
        role: "proof",
        reason: "Show the visual evidence.",
      },
    ]
  );
});

test("editGraphFromTimeline preserves existing segment rationale", () => {
  const timeline: Timeline = {
    aspectRatio: "9:16",
    fps: 30,
    segments: [
      {
        id: "seg_existing",
        clipId: "clip_b",
        sourceInSec: 1,
        sourceOutSec: 4,
        role: "proof",
        reason: "Critic picked the clearest evidence shot.",
        caption: "Watch the water line",
      },
    ],
    showCaptions: true,
  };

  const graph = editGraphFromTimeline({
    goal: "Explain tides",
    plan,
    timeline,
  });
  const compiled = compileEditGraphToTimeline({
    graph,
    aspectRatio: timeline.aspectRatio,
    fps: timeline.fps,
    showCaptions: timeline.showCaptions,
  });

  assert.deepEqual(compiled, timeline);
});

test("editGraphFromTimeline preserves roles that do not match a plan beat", () => {
  // `add_segment` patches and imported/older timelines can introduce roles that
  // do not exactly match any plan.beats[].name. The original role must survive a
  // graph round-trip rather than being overwritten with a fallback beat's name.
  const timeline: Timeline = {
    aspectRatio: "9:16",
    fps: 30,
    segments: [
      {
        id: "seg_hook",
        clipId: "clip_a",
        sourceInSec: 0,
        sourceOutSec: 3,
        role: "hook",
        reason: "Open strong.",
      },
      {
        id: "seg_patch",
        clipId: "clip_b",
        sourceInSec: 0,
        sourceOutSec: 2,
        role: "B-roll insert", // arbitrary role with no matching beat name
        reason: "Critic added a cutaway.",
      },
    ],
  };

  const graph = editGraphFromTimeline({
    goal: "Explain tides",
    plan,
    timeline,
  });

  // The decision carries the original role even though it falls back to a beat
  // for association.
  assert.equal(graph.decisions[1].role, "B-roll insert");

  const compiled = compileEditGraphToTimeline({
    graph,
    aspectRatio: timeline.aspectRatio,
    fps: timeline.fps,
  });

  assert.deepEqual(
    compiled.segments.map((segment) => segment.role),
    ["hook", "B-roll insert"]
  );
});
