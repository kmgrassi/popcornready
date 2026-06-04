import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { MODEL, structuredVisionCall } from "./anthropic";

const execFileAsync = promisify(execFile);

export type StitchReviewGrade = "pass" | "needs_review" | "fail";

// The dimension scores the stitch judge returns. Mirrors VideoSnapshotReview's
// pass/needs_review/fail grades but covers the stitch-specific dimensions called
// out in the stage-eval scope §7: order, continuity, pacing, gaps/overlaps, and
// audio sync.
export interface StitchContinuityDimensions {
  orderCorrectness: StitchReviewGrade;
  continuityAcrossCuts: StitchReviewGrade;
  pacingAdherence: StitchReviewGrade;
  gapsOverlaps: StitchReviewGrade;
  audioSync?: StitchReviewGrade;
}

// The judge's structured verdict on the assembled cut. Output shape mirrors
// VideoSnapshotReview (per-dimension grades + recommendedAction + notes) but for
// the stitched timeline rather than a single clip.
export interface StitchContinuityReview extends StitchContinuityDimensions {
  continuityNotes: string;
  recommendedAction: "keep" | "regenerate" | "manual_review";
  // The boundary frames the judge saw, as served/relative paths.
  boundaryFrames: StitchBoundaryFrame[];
  reviewer: {
    provider: string;
    model?: string;
  };
}

// One cut boundary: the last frame of clip N and the first frame of clip N+1.
export interface StitchBoundaryFrame {
  cutIndex: number;
  fromSegmentId: string;
  toSegmentId: string;
  fromBeat?: string;
  toBeat?: string;
  lastFramePath: string;
  firstFramePath: string;
}

// A single clip in the assembled cut, in render order. Carries the source video
// path so boundary frames can be extracted, plus the planned beat it serves and
// its duration so the judge can check order + pacing.
export interface StitchClip {
  segmentId: string;
  beat?: string;
  videoPath: string;
  durationSec: number;
  // Optional measured duration decoded from the media, when it differs from the
  // planned/requested durationSec — used to flag pacing drift.
  measuredDurationSec?: number;
}

export interface StitchTimelineSummary {
  // The planned beat order the assembled cut is supposed to follow.
  intendedBeatOrder: string[];
  // Per-beat planned durations keyed by beat name, when available.
  plannedDurationsSec?: Record<string, number>;
  targetLengthSec?: number;
  hasAudio?: boolean;
}

// The model-call seam. Tests inject a mock so they never hit a real provider;
// production passes `defaultStitchVisionJudge`. The judge receives ONLY the
// assembled output evidence (boundary frames + timeline summary), never the
// generation prompts — context isolation per scope §3.
export type StitchVisionJudge = (input: {
  system: string;
  user: string;
  images: { path: string; mediaType: "image/png" | "image/jpeg" }[];
}) => Promise<{
  result: Omit<StitchContinuityReview, "boundaryFrames" | "reviewer">;
  provider: string;
  model?: string;
}>;

const visionSchema = {
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
    continuityNotes: { type: "string" },
    recommendedAction: {
      type: "string",
      enum: ["keep", "regenerate", "manual_review"],
    },
  },
  required: [
    "orderCorrectness",
    "continuityAcrossCuts",
    "pacingAdherence",
    "gapsOverlaps",
    "continuityNotes",
    "recommendedAction",
  ],
} as const;

function mediaTypeFor(filePath: string): "image/png" | "image/jpeg" {
  return /\.(jpe?g)$/i.test(filePath) ? "image/jpeg" : "image/png";
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync("which", [command]);
    return true;
  } catch {
    return false;
  }
}

async function extractFrameAt(input: {
  videoPath: string;
  atSec: number;
  outputPath: string;
}): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-y",
    "-ss",
    input.atSec.toFixed(2),
    "-i",
    input.videoPath,
    "-frames:v",
    "1",
    input.outputPath,
  ]);
}

export function boundarySampleDurationSec(clip: StitchClip): number {
  return Math.max(
    0.2,
    Number(clip.measuredDurationSec ?? clip.durationSec) || 0.2
  );
}

// Extract the boundary frames across every cut: the last frame of clip N and the
// first frame of clip N+1. Reuses the same ffmpeg single-frame approach as
// extractVideoSnapshots in video-snapshot-review.ts. Returns [] when ffmpeg is
// unavailable so callers degrade gracefully (same contract as snapshot review).
export async function extractBoundaryFrames(input: {
  clips: StitchClip[];
  outputDir: string;
}): Promise<StitchBoundaryFrame[]> {
  if (input.clips.length < 2) return [];
  if (!(await commandExists("ffmpeg"))) return [];
  await fs.mkdir(input.outputDir, { recursive: true });

  const boundaries: StitchBoundaryFrame[] = [];
  for (let index = 0; index < input.clips.length - 1; index += 1) {
    const from = input.clips[index];
    const to = input.clips[index + 1];
    const fromDuration = boundarySampleDurationSec(from);
    // Sample just inside each edge to avoid black/partial boundary frames.
    const lastAt = Math.max(0.1, fromDuration - 0.1);
    const firstAt = 0.1;
    const lastFramePath = path.join(
      input.outputDir,
      `cut_${index + 1}_last.png`
    );
    const firstFramePath = path.join(
      input.outputDir,
      `cut_${index + 1}_first.png`
    );
    await extractFrameAt({
      videoPath: from.videoPath,
      atSec: lastAt,
      outputPath: lastFramePath,
    });
    await extractFrameAt({
      videoPath: to.videoPath,
      atSec: firstAt,
      outputPath: firstFramePath,
    });
    boundaries.push({
      cutIndex: index + 1,
      fromSegmentId: from.segmentId,
      toSegmentId: to.segmentId,
      fromBeat: from.beat,
      toBeat: to.beat,
      lastFramePath,
      firstFramePath,
    });
  }
  return boundaries;
}

const SYSTEM_PROMPT = `You review the assembled cut of an AI-generated video that
stitches many short clips together. You receive, for every cut boundary, the LAST
frame of the outgoing clip immediately followed by the FIRST frame of the incoming
clip, plus a summary of the assembled timeline and the planned beat order. You do
NOT see the generation prompts.

Grade the stitched cut on:
- orderCorrectness: do the clips follow the planned beat sequence?
- continuityAcrossCuts: across each cut, do subject / lighting / scene jumps read
  as errors, or as intentional cuts? Hard, jarring discontinuities that break the
  story are failures; deliberate scene changes are fine.
- pacingAdherence: do clip durations match the plan's intended pacing?
- gapsOverlaps: are there missing or duplicated beats, gaps, or overlaps?
- audioSync: if audio is present, does it track the visuals? Omit if no audio.

Be strict but practical. Use "needs_review" when the boundary frames are
ambiguous. Recommend "regenerate" only for clear stitching failures. Return JSON
only.`;

function timelineSummaryText(timeline: StitchTimelineSummary): string {
  const lines = [
    `Intended beat order (planned): ${timeline.intendedBeatOrder.join(" -> ")}`,
  ];
  if (timeline.targetLengthSec != null) {
    lines.push(`Target total length: ${timeline.targetLengthSec}s`);
  }
  if (timeline.plannedDurationsSec) {
    const durations = Object.entries(timeline.plannedDurationsSec)
      .map(([beat, sec]) => `${beat}=${sec}s`)
      .join(", ");
    lines.push(`Planned per-beat durations: ${durations}`);
  }
  lines.push(`Audio present: ${timeline.hasAudio ? "yes" : "no"}`);
  return lines.join("\n");
}

function assembledOrderText(clips: StitchClip[]): string {
  return clips
    .map((clip, index) => {
      const measured =
        clip.measuredDurationSec != null &&
        clip.measuredDurationSec !== clip.durationSec
          ? ` (measured ${clip.measuredDurationSec}s)`
          : "";
      return `${index + 1}. beat=${clip.beat ?? "?"} duration=${clip.durationSec}s${measured} segment=${clip.segmentId}`;
    })
    .join("\n");
}

function boundaryDescriptionText(boundaries: StitchBoundaryFrame[]): string {
  return boundaries
    .map(
      (boundary) =>
        `Cut ${boundary.cutIndex}: ${boundary.fromBeat ?? "?"} -> ${boundary.toBeat ?? "?"} ` +
        `(images ${boundary.cutIndex * 2 - 1} = last frame of outgoing, ` +
        `${boundary.cutIndex * 2} = first frame of incoming)`
    )
    .join("\n");
}

// The production judge: validates the structured vision call against the schema
// and pins the Anthropic model. Mirrors reviewWithAnthropic in
// video-snapshot-review.ts.
export const defaultStitchVisionJudge: StitchVisionJudge = async (input) => {
  const result = await structuredVisionCall<
    Omit<StitchContinuityReview, "boundaryFrames" | "reviewer">
  >({
    cachedSystem: input.system,
    user: input.user,
    schema: visionSchema as unknown as Record<string, unknown>,
    images: input.images,
    maxTokens: 2000,
  });
  return { result, provider: "anthropic", model: MODEL };
};

// Build the user prompt + image list from the assembled-output evidence only.
// Exposed so the eval-side evaluator can drive a (mocked) judge without invoking
// ffmpeg, and so the prompt stays context-isolated.
export function buildStitchReviewRequest(input: {
  timeline: StitchTimelineSummary;
  clips: StitchClip[];
  boundaryFrames: StitchBoundaryFrame[];
}): {
  system: string;
  user: string;
  images: { path: string; mediaType: "image/png" | "image/jpeg" }[];
} {
  const images = input.boundaryFrames.flatMap((boundary) => [
    {
      path: boundary.lastFramePath,
      mediaType: mediaTypeFor(boundary.lastFramePath),
    },
    {
      path: boundary.firstFramePath,
      mediaType: mediaTypeFor(boundary.firstFramePath),
    },
  ]);

  const user = `Planned timeline:
${timelineSummaryText(input.timeline)}

Assembled clip order (as stitched):
${assembledOrderText(input.clips)}

Cut boundaries (paired boundary frames follow, in order):
${boundaryDescriptionText(input.boundaryFrames)}

For each cut, image (2*cut-1) is the last frame of the outgoing clip and image
(2*cut) is the first frame of the incoming clip. Judge order, continuity across
each cut, pacing vs the planned durations, gaps/overlaps, and audio sync if
present.`;

  return { system: SYSTEM_PROMPT, user, images };
}

// Review the assembled cut for stitching continuity. Extracts boundary frames
// with ffmpeg (when available), then calls the (injectable) vision judge with the
// assembled output + intended plan only. Returns null when there is nothing to
// judge (fewer than two clips, or ffmpeg unavailable so no boundary evidence) —
// same graceful-degradation contract as reviewGeneratedVideoSnapshots.
export async function reviewStitchContinuity(input: {
  timeline: StitchTimelineSummary;
  clips: StitchClip[];
  outputDir?: string;
  // Pre-extracted boundary frames (e.g. from an offline fixture). When provided,
  // ffmpeg extraction is skipped.
  boundaryFrames?: StitchBoundaryFrame[];
  judge?: StitchVisionJudge;
}): Promise<StitchContinuityReview | null> {
  const judge = input.judge ?? defaultStitchVisionJudge;

  const boundaryFrames =
    input.boundaryFrames ??
    (await extractBoundaryFrames({
      clips: input.clips,
      outputDir:
        input.outputDir ??
        path.join(process.cwd(), "public", "generated", "stitch-boundaries"),
    }));

  if (boundaryFrames.length === 0) return null;

  const request = buildStitchReviewRequest({
    timeline: input.timeline,
    clips: input.clips,
    boundaryFrames,
  });

  const { result, provider, model } = await judge(request);

  return {
    ...result,
    boundaryFrames,
    reviewer: { provider, ...(model ? { model } : {}) },
  };
}
