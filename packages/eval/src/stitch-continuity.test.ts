import assert from "node:assert/strict";
import test from "node:test";

import type {
  StitchBoundaryFrame,
  StitchClip,
  StitchTimelineSummary,
  StitchVisionJudge,
} from "@popcorn/agent";

import { createEvaluatorRegistry } from "./registry";
import { runEvalSuite } from "./runner";
import {
  createStitchContinuityEvaluator,
  STITCH_CONTINUITY_EVALUATOR_ID,
} from "./stitch-continuity";
import type { EvaluatorContext, EvalSuiteFixture, JudgmentGrade } from "./types";
import { computeVerdict } from "./verdict";

// A deterministic stand-in for the vision model. It never reads pixels — it
// derives grades from the assembled-output evidence the framework hands it (the
// intended beat order + the assembled clip order parsed from the prompt, and a
// per-cut continuity-break flag carried on the boundary-frame paths). This proves
// the evaluator wiring end-to-end (frames -> request -> grades -> verdict) without
// hitting a provider, exactly as the scope requires the model call be mockable.
const fakeStitchJudge: StitchVisionJudge = async (input) => {
  const intended = parseList(input.user, "Intended beat order (planned):", "->");
  const assembled = parseAssembledBeats(input.user);

  const orderCorrectness: JudgmentGrade =
    arraysEqual(intended, assembled) ? "pass" : "fail";

  // The fixtures encode a continuity break by tagging the incoming first-frame
  // path with "__BREAK__". A real judge would see the jarring jump in pixels; the
  // fake reads the tag so tests stay deterministic.
  const hasBreak = input.images.some((image) => image.path.includes("__BREAK__"));
  const continuityAcrossCuts: JudgmentGrade = hasBreak ? "fail" : "pass";

  return {
    result: {
      orderCorrectness: asGrade(orderCorrectness),
      continuityAcrossCuts: asGrade(continuityAcrossCuts),
      pacingAdherence: "pass",
      gapsOverlaps: "pass",
      continuityNotes: hasBreak
        ? "Hard subject/lighting jump at a cut reads as an error."
        : arraysEqual(intended, assembled)
          ? "Clips follow the planned beat order with clean cuts."
          : "Clips are out of order versus the planned beat sequence.",
      recommendedAction:
        orderCorrectness === "fail" || continuityAcrossCuts === "fail"
          ? "regenerate"
          : "keep",
    },
    provider: "fake",
    model: "fake-judge",
  };
};

function asGrade(grade: JudgmentGrade): "pass" | "needs_review" | "fail" {
  return grade as "pass" | "needs_review" | "fail";
}

function parseList(text: string, label: string, sep: string): string[] {
  const line = text.split("\n").find((row) => row.startsWith(label));
  if (!line) return [];
  return line
    .slice(label.length)
    .split(sep)
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseAssembledBeats(text: string): string[] {
  return text
    .split("\n")
    .map((row) => row.match(/^\d+\.\s+beat=(\S+)/))
    .filter((match): match is RegExpMatchArray => match != null)
    .map((match) => match[1]);
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

const INTENDED_BEATS = ["hook", "problem", "solution", "cta"];

function clip(beat: string, segmentId: string): StitchClip {
  return { segmentId, beat, videoPath: `/clips/${segmentId}.mp4`, durationSec: 5 };
}

// Pre-extracted boundary frames so the test never shells out to ffmpeg. `broken`
// tags the incoming first frame so the fake judge flags a continuity break there.
function boundariesFor(
  clips: StitchClip[],
  broken: number[] = []
): StitchBoundaryFrame[] {
  const frames: StitchBoundaryFrame[] = [];
  for (let index = 0; index < clips.length - 1; index += 1) {
    const cutIndex = index + 1;
    const broke = broken.includes(cutIndex);
    frames.push({
      cutIndex,
      fromSegmentId: clips[index].segmentId,
      toSegmentId: clips[index + 1].segmentId,
      fromBeat: clips[index].beat,
      toBeat: clips[index + 1].beat,
      lastFramePath: `/frames/cut_${cutIndex}_last.png`,
      firstFramePath: broke
        ? `/frames/cut_${cutIndex}_first__BREAK__.png`
        : `/frames/cut_${cutIndex}_first.png`,
    });
  }
  return frames;
}

const timeline: StitchTimelineSummary = {
  intendedBeatOrder: INTENDED_BEATS,
  targetLengthSec: 20,
  hasAudio: false,
};

function contextFor(
  clips: StitchClip[],
  boundaryFrames?: StitchBoundaryFrame[]
): EvaluatorContext {
  return {
    stageType: "export",
    modality: "video",
    artifact: { timeline, clips, ...(boundaryFrames ? { boundaryFrames } : {}) },
    intent: { intendedBeatOrder: INTENDED_BEATS },
    stageId: "case:export",
    trigger: "auto",
  };
}

test("createStitchContinuityEvaluator resolves the stitch_continuity.v1 policy id", () => {
  const evaluator = createStitchContinuityEvaluator({ judge: fakeStitchJudge });
  assert.equal(evaluator.id, STITCH_CONTINUITY_EVALUATOR_ID);
  assert.equal(evaluator.stageType, "export");
  assert.deepEqual(evaluator.evidenceNeeded.includes("boundary_frames"), true);

  const registry = createEvaluatorRegistry([evaluator]);
  assert.equal(registry.get(STITCH_CONTINUITY_EVALUATOR_ID), evaluator);
  assert.deepEqual(registry.forStage("export"), [evaluator]);
});

test("a clean, in-order cut sequence passes on every dimension", async () => {
  const evaluator = createStitchContinuityEvaluator({ judge: fakeStitchJudge });
  const clips = INTENDED_BEATS.map((beat, index) => clip(beat, `seg-${index}`));
  const draft = await evaluator.run(contextFor(clips, boundariesFor(clips)));

  assert.equal(draft.grades.orderCorrectness, "pass");
  assert.equal(draft.grades.continuityAcrossCuts, "pass");
  assert.equal(draft.recommendedAction, "keep");
  assert.equal(computeVerdict(draft.grades, evaluator.thresholds), "pass");
});

test("a scrambled / out-of-order sequence fails with order as the low dimension", async () => {
  const evaluator = createStitchContinuityEvaluator({ judge: fakeStitchJudge });
  // Same clips, deliberately reordered so they no longer follow the planned beats.
  const scrambled = [
    clip("solution", "seg-2"),
    clip("hook", "seg-0"),
    clip("cta", "seg-3"),
    clip("problem", "seg-1"),
  ];
  const draft = await evaluator.run(
    contextFor(scrambled, boundariesFor(scrambled))
  );

  assert.equal(draft.grades.orderCorrectness, "fail");
  // Order is the failing dimension; continuity is unaffected in this fixture.
  assert.equal(draft.grades.continuityAcrossCuts, "pass");
  assert.equal(draft.recommendedAction, "regenerate");
  assert.equal(computeVerdict(draft.grades, evaluator.thresholds), "fail");
});

test("missing boundary frames still fail an out-of-order assembled sequence", async () => {
  const evaluator = createStitchContinuityEvaluator({ judge: fakeStitchJudge });
  const scrambled = [
    clip("solution", "seg-2"),
    clip("hook", "seg-0"),
    clip("cta", "seg-3"),
    clip("problem", "seg-1"),
  ];
  const draft = await evaluator.run(contextFor(scrambled, []));

  assert.equal(draft.grades.orderCorrectness, "fail");
  assert.equal(draft.grades.continuityAcrossCuts, "pass");
  assert.equal(draft.grades.gapsOverlaps, "needs_review");
  assert.equal(draft.recommendedAction, "manual_review");
  assert.equal(computeVerdict(draft.grades, evaluator.thresholds), "fail");
});

test("missing boundary frames still grade pacing from measured durations", async () => {
  const evaluator = createStitchContinuityEvaluator({ judge: fakeStitchJudge });
  const clips = INTENDED_BEATS.map((beat, index) => ({
    ...clip(beat, `seg-${index}`),
    measuredDurationSec: index === 1 ? 2 : 5,
  }));
  const draft = await evaluator.run({
    stageType: "export",
    modality: "video",
    artifact: {
      timeline: {
        ...timeline,
        plannedDurationsSec: {
          hook: 5,
          problem: 5,
          solution: 5,
          cta: 5,
        },
      },
      clips,
      boundaryFrames: [],
    },
    stageId: "case:export",
    trigger: "auto",
  });

  assert.equal(draft.grades.orderCorrectness, "pass");
  assert.equal(draft.grades.pacingAdherence, "fail");
  assert.equal(computeVerdict(draft.grades, evaluator.thresholds), "fail");
});

test("a continuity break across a cut is caught", async () => {
  const evaluator = createStitchContinuityEvaluator({ judge: fakeStitchJudge });
  const clips = INTENDED_BEATS.map((beat, index) => clip(beat, `seg-${index}`));
  // Cut 2 (problem -> solution) has a jarring subject/lighting jump.
  const draft = await evaluator.run(
    contextFor(clips, boundariesFor(clips, [2]))
  );

  assert.equal(draft.grades.orderCorrectness, "pass");
  assert.equal(draft.grades.continuityAcrossCuts, "fail");
  assert.equal(draft.recommendedAction, "regenerate");
  assert.equal(computeVerdict(draft.grades, evaluator.thresholds), "fail");
});

test("audioSync is graded only when the timeline carries audio", async () => {
  const audioJudge: StitchVisionJudge = async () => ({
    result: {
      orderCorrectness: "pass",
      continuityAcrossCuts: "pass",
      pacingAdherence: "pass",
      gapsOverlaps: "pass",
      audioSync: "needs_review",
      continuityNotes: "Audio drifts slightly behind the visuals.",
      recommendedAction: "manual_review",
    },
    provider: "fake",
    model: "fake-judge",
  });
  const evaluator = createStitchContinuityEvaluator({ judge: audioJudge });
  const clips = INTENDED_BEATS.map((beat, index) => clip(beat, `seg-${index}`));

  const withAudio = await evaluator.run({
    stageType: "export",
    modality: "video",
    artifact: {
      timeline: { ...timeline, hasAudio: true },
      clips,
      boundaryFrames: boundariesFor(clips),
    },
    stageId: "case:export",
    trigger: "auto",
  });
  assert.equal(withAudio.grades.audioSync, "needs_review");
  assert.equal(computeVerdict(withAudio.grades, evaluator.thresholds), "needs_review");

  const withoutAudio = await evaluator.run(contextFor(clips, boundariesFor(clips)));
  assert.equal("audioSync" in withoutAudio.grades, false);
});

// §5 calibration: deliberately-broken fixtures with known answers run through the
// suite harness, proving the judge catches the bad cases and passes the good one.
test("suite calibration: known-good passes, scrambled + continuity-break fail", async () => {
  const evaluator = createStitchContinuityEvaluator({ judge: fakeStitchJudge });
  const registry = createEvaluatorRegistry([evaluator]);

  const cleanClips = INTENDED_BEATS.map((beat, index) => clip(beat, `seg-${index}`));
  const scrambledClips = [
    clip("solution", "seg-2"),
    clip("hook", "seg-0"),
    clip("cta", "seg-3"),
    clip("problem", "seg-1"),
  ];
  const breakClips = INTENDED_BEATS.map((beat, index) => clip(beat, `seg-${index}`));

  const fixture: EvalSuiteFixture = {
    suite: { id: "stitch-suite", name: "Stitch continuity calibration" },
    cases: [
      {
        id: "case-clean",
        suiteId: "stitch-suite",
        label: "Clean in-order cut",
        stimulus: { kind: "frozen_artifact", stageType: "export", artifact: {} },
        stagesToRun: ["export"],
        expectations: [
          { stageType: "export", assertions: ["order and continuity hold"] },
        ],
        artifacts: [
          {
            stageType: "export",
            artifactId: "cut-clean",
            artifact: {
              timeline,
              clips: cleanClips,
              boundaryFrames: boundariesFor(cleanClips),
            },
          },
        ],
      },
      {
        id: "case-scrambled",
        suiteId: "stitch-suite",
        label: "Out-of-order cut",
        stimulus: { kind: "frozen_artifact", stageType: "export", artifact: {} },
        stagesToRun: ["export"],
        artifacts: [
          {
            stageType: "export",
            artifactId: "cut-scrambled",
            artifact: {
              timeline,
              clips: scrambledClips,
              boundaryFrames: boundariesFor(scrambledClips),
            },
          },
        ],
      },
      {
        id: "case-break",
        suiteId: "stitch-suite",
        label: "Continuity break at a cut",
        stimulus: { kind: "frozen_artifact", stageType: "export", artifact: {} },
        stagesToRun: ["export"],
        artifacts: [
          {
            stageType: "export",
            artifactId: "cut-break",
            artifact: {
              timeline,
              clips: breakClips,
              boundaryFrames: boundariesFor(breakClips, [2]),
            },
          },
        ],
      },
    ],
  };

  const result = await runEvalSuite({
    registry,
    fixture,
    gitSha: "deadbeef",
    branch: "feat/eval-stitch-judge",
  });

  const byArtifact = new Map(
    result.judgments.map((judgment) => [judgment.artifactId, judgment])
  );
  assert.equal(byArtifact.get("cut-clean")?.verdict, "pass");
  assert.equal(byArtifact.get("cut-scrambled")?.verdict, "fail");
  assert.equal(byArtifact.get("cut-scrambled")?.grades.orderCorrectness, "fail");
  assert.equal(byArtifact.get("cut-break")?.verdict, "fail");
  assert.equal(byArtifact.get("cut-break")?.grades.continuityAcrossCuts, "fail");

  // The judges are append-only Judgment rows pinned to the evaluator's model.
  assert.equal(result.judgments.length, 3);
  assert.deepEqual(result.evalRun.judgeModels, {
    [STITCH_CONTINUITY_EVALUATOR_ID]: "claude-opus-4-7",
  });
  assert.equal(result.evalRun.aggregate?.failRate, 2 / 3);
});
