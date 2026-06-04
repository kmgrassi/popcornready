import {
  reviewStitchContinuity,
  type StitchBoundaryFrame,
  type StitchClip,
  type StitchContinuityReview,
  type StitchTimelineSummary,
  type StitchVisionJudge,
} from "@popcorn/agent";

import type {
  Evaluator,
  EvaluatorContext,
  JudgmentDraft,
  JudgmentGrade,
} from "./types";

export const STITCH_CONTINUITY_EVALUATOR_ID = "stitch_continuity.v1";

// The artifact the stitch evaluator judges: the assembled output (clips in render
// order) plus an independently-derived summary of the planned timeline/order. The
// judge sees ONLY this — never the generation prompts — per context isolation
// (scope §3). `boundaryFrames` may be supplied directly (offline fixtures) or
// extracted with ffmpeg from the clip video paths.
export interface StitchContinuityArtifact {
  timeline: StitchTimelineSummary;
  clips: StitchClip[];
  boundaryFrames?: StitchBoundaryFrame[];
  outputDir?: string;
}

// The judge supplies pass/needs_review/fail per dimension; the framework recomputes
// the verdict from these grades (never the model's own field) via computeVerdict.
// audioSync is only graded when the timeline has audio, so it is omitted otherwise.
function gradesFromReview(
  review: StitchContinuityReview,
  hasAudio: boolean
): Record<string, JudgmentGrade> {
  const grades: Record<string, JudgmentGrade> = {
    orderCorrectness: review.orderCorrectness,
    continuityAcrossCuts: review.continuityAcrossCuts,
    pacingAdherence: review.pacingAdherence,
    gapsOverlaps: review.gapsOverlaps,
  };
  if (hasAudio && review.audioSync) {
    grades.audioSync = review.audioSync;
  }
  return grades;
}

const stitchVerdictSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    orderCorrectness: { type: "string", enum: ["pass", "needs_review", "fail"] },
    continuityAcrossCuts: {
      type: "string",
      enum: ["pass", "needs_review", "fail"],
    },
    pacingAdherence: { type: "string", enum: ["pass", "needs_review", "fail"] },
    gapsOverlaps: { type: "string", enum: ["pass", "needs_review", "fail"] },
    audioSync: { type: "string", enum: ["pass", "needs_review", "fail"] },
  },
  required: [
    "orderCorrectness",
    "continuityAcrossCuts",
    "pacingAdherence",
    "gapsOverlaps",
  ],
} as const;

function artifactFrom(ctx: EvaluatorContext): StitchContinuityArtifact {
  const artifact = ctx.artifact as StitchContinuityArtifact | undefined;
  if (
    !artifact ||
    typeof artifact !== "object" ||
    !Array.isArray(artifact.clips) ||
    !artifact.timeline ||
    !Array.isArray(artifact.timeline.intendedBeatOrder)
  ) {
    throw new Error(
      "stitch_continuity evaluator requires an artifact with { timeline.intendedBeatOrder, clips[] }"
    );
  }
  return artifact;
}

function assembledBeatOrder(clips: StitchClip[]): string[] {
  return clips.map((clip) => clip.beat).filter((beat): beat is string => !!beat);
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function fallbackOrderGrade(artifact: StitchContinuityArtifact): JudgmentGrade {
  if (artifact.clips.length < 2) return "pass";
  const assembled = assembledBeatOrder(artifact.clips);
  if (assembled.length === 0 || artifact.timeline.intendedBeatOrder.length === 0) {
    return "needs_review";
  }
  return arraysEqual(artifact.timeline.intendedBeatOrder, assembled) ? "pass" : "fail";
}

function fallbackPacingGrade(artifact: StitchContinuityArtifact): JudgmentGrade {
  const planned = artifact.timeline.plannedDurationsSec;
  if (!planned) return "pass";

  let compared = 0;
  for (const clip of artifact.clips) {
    if (!clip.beat || planned[clip.beat] == null) continue;
    compared += 1;
    const actual = clip.measuredDurationSec ?? clip.durationSec;
    const expected = planned[clip.beat];
    const toleranceSec = Math.max(0.25, expected * 0.1);
    if (Math.abs(actual - expected) > toleranceSec) return "fail";
  }

  return compared > 0 ? "pass" : "needs_review";
}

export interface CreateStitchContinuityEvaluatorOptions {
  // The (mockable) vision judge. Tests inject a stub so they never hit a real
  // provider; production omits this and the agent helper's default Anthropic
  // judge is used.
  judge?: StitchVisionJudge;
  judgeModel?: string;
  rubricVersion?: string;
}

// Build the stitch_continuity evaluator. Resolves the `stitch_continuity.v1`
// policy entry to a concrete Evaluator that reuses the agent vision-judge helper.
export function createStitchContinuityEvaluator(
  options: CreateStitchContinuityEvaluatorOptions = {}
): Evaluator {
  return {
    id: STITCH_CONTINUITY_EVALUATOR_ID,
    stageType: "export",
    modality: "video",
    rubricVersion: options.rubricVersion ?? "2026-06-04",
    judgeModel: options.judgeModel ?? "claude-opus-4-7",
    schema: stitchVerdictSchema,
    evidenceNeeded: ["boundary_frames", "rendered_preview"],
    style: "reference_free",
    mode: "observational",
    // No numeric thresholds: every dimension is a pass/needs_review/fail grade,
    // which computeVerdict treats authoritatively (a single `fail` fails the cut).
    thresholds: {},
    async run(ctx: EvaluatorContext): Promise<JudgmentDraft> {
      const artifact = artifactFrom(ctx);
      const hasAudio = artifact.timeline.hasAudio === true;
      const startedAt = Date.now();

      const review = await reviewStitchContinuity({
        timeline: artifact.timeline,
        clips: artifact.clips,
        boundaryFrames: artifact.boundaryFrames,
        outputDir: artifact.outputDir,
        judge: options.judge,
      });

      const latencyMs = Date.now() - startedAt;

      if (!review) {
        // No boundary evidence (e.g. a single clip, or ffmpeg unavailable). Still
        // grade dimensions available from structured artifact data so a scrambled
        // or badly paced assembled cut does not get hidden behind missing frames.
        return {
          grades: {
            orderCorrectness: fallbackOrderGrade(artifact),
            continuityAcrossCuts: "pass",
            pacingAdherence: fallbackPacingGrade(artifact),
            gapsOverlaps: "needs_review",
          },
          rationale:
            "No cut boundaries to judge (single clip or boundary frames unavailable).",
          recommendedAction: "manual_review",
          evidenceRef: ctx.evidenceRef,
          latencyMs,
        };
      }

      return {
        grades: gradesFromReview(review, hasAudio),
        rationale: review.continuityNotes,
        recommendedAction: review.recommendedAction,
        evidenceRef: ctx.evidenceRef,
        latencyMs,
      };
    },
  };
}
