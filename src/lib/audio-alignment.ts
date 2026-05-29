// Audio/visual duration alignment. Agents asking for a fixed-length video need
// the narration and the visual timeline to line up; this module holds the pure
// decision logic so it can be unit tested and reused by both the export route
// (validation before render) and the align-audio route (corrective strategies).

export type DurationPolicy =
  | "timeline_only" // render exactly the timeline duration
  | "match_longest_media" // extend export so selected audio is never cut
  | "fail_on_mismatch"; // refuse to export when durations diverge

export type AlignmentStrategy =
  | "rewrite_script" // rewrite + regenerate narration to fit the timeline
  | "extend_timeline" // lengthen strong visual beats to fit the narration
  | "render_longest" // accept the longer media duration (drafts/previews)
  | "fail"; // surface a typed error for the caller to handle

export const DEFAULT_MAX_DELTA_SEC = 1.0;
export const DEFAULT_DURATION_POLICY: DurationPolicy = "match_longest_media";
// ~150 words per minute is a comfortable conversational narration pace.
export const NARRATION_WORDS_PER_SEC = 2.5;

export const DURATION_POLICIES: DurationPolicy[] = [
  "timeline_only",
  "match_longest_media",
  "fail_on_mismatch",
];

export const ALIGNMENT_STRATEGIES: AlignmentStrategy[] = [
  "rewrite_script",
  "extend_timeline",
  "render_longest",
  "fail",
];

export interface DurationComparison {
  timelineDurationSec: number;
  audioDurationSec: number;
  deltaSec: number; // absolute difference
  maxDeltaSec: number;
  withinThreshold: boolean;
  longer: "audio" | "timeline" | "none";
}

export interface ExportAlignmentError {
  code: "audio_timeline_mismatch";
  message: string;
  details: {
    timelineDurationSec: number;
    audioDurationSec: number;
    deltaSec: number;
    maxDeltaSec: number;
    suggestedStrategies: AlignmentStrategy[];
  };
}

export interface ExportAlignmentResult {
  ok: boolean; // whether the export may proceed
  policy: DurationPolicy;
  exportDurationSec: number; // duration the export should render to
  truncatesAudio: boolean; // whether selected audio would be cut off
  comparison: DurationComparison;
  warning?: string;
  error?: ExportAlignmentError;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function compareDurations(input: {
  timelineDurationSec: number;
  audioDurationSec: number;
  maxDeltaSec?: number;
}): DurationComparison {
  const timelineDurationSec = Math.max(0, input.timelineDurationSec);
  const audioDurationSec = Math.max(0, input.audioDurationSec);
  const maxDeltaSec = Math.max(0, input.maxDeltaSec ?? DEFAULT_MAX_DELTA_SEC);
  const deltaSec = round(Math.abs(timelineDurationSec - audioDurationSec));
  const longer =
    deltaSec <= 1e-6
      ? "none"
      : audioDurationSec > timelineDurationSec
        ? "audio"
        : "timeline";

  return {
    timelineDurationSec: round(timelineDurationSec),
    audioDurationSec: round(audioDurationSec),
    deltaSec,
    maxDeltaSec,
    withinThreshold: deltaSec <= maxDeltaSec,
    longer,
  };
}

// Decides whether an export may proceed and how long it should render, given a
// duration policy. Critically, narration is never *silently* truncated: the
// only way to cut audio is an explicit `timeline_only` request, which still
// reports the truncation back to the caller.
export function evaluateExportPolicy(input: {
  policy?: DurationPolicy;
  timelineDurationSec: number;
  audioDurationSec: number;
  maxDeltaSec?: number;
}): ExportAlignmentResult {
  const policy = input.policy ?? DEFAULT_DURATION_POLICY;
  const comparison = compareDurations(input);
  const { timelineDurationSec, audioDurationSec, deltaSec, maxDeltaSec } =
    comparison;
  const longest = round(Math.max(timelineDurationSec, audioDurationSec));

  // No selected audio: nothing to align against.
  if (audioDurationSec <= 0) {
    return {
      ok: true,
      policy,
      exportDurationSec: timelineDurationSec,
      truncatesAudio: false,
      comparison,
    };
  }

  if (policy === "timeline_only") {
    // Any audio longer than the rendered timeline is cut — flag it regardless
    // of the mismatch threshold so narration is never silently truncated.
    // (maxDeltaSec only governs fail/mismatch decisions, not truncation.)
    const truncatesAudio = audioDurationSec > timelineDurationSec + 1e-6;
    return {
      ok: true,
      policy,
      exportDurationSec: timelineDurationSec,
      truncatesAudio,
      comparison,
      warning: truncatesAudio
        ? `Rendering timeline_only will cut ${round(
            audioDurationSec - timelineDurationSec
          )}s of narration. Choose match_longest_media or align the audio to keep it whole.`
        : undefined,
    };
  }

  if (policy === "fail_on_mismatch" && !comparison.withinThreshold) {
    return {
      ok: false,
      policy,
      exportDurationSec: longest,
      truncatesAudio: false,
      comparison,
      error: {
        code: "audio_timeline_mismatch",
        message: `Audio (${audioDurationSec}s) and timeline (${timelineDurationSec}s) differ by ${deltaSec}s, beyond the ${maxDeltaSec}s threshold.`,
        details: {
          timelineDurationSec,
          audioDurationSec,
          deltaSec,
          maxDeltaSec,
          suggestedStrategies:
            comparison.longer === "audio"
              ? ["rewrite_script", "extend_timeline", "render_longest"]
              : ["rewrite_script", "render_longest"],
        },
      },
    };
  }

  // match_longest_media, or fail_on_mismatch within threshold: render to the
  // longer of the two so the audio always plays out fully.
  return {
    ok: true,
    policy,
    exportDurationSec: longest,
    truncatesAudio: false,
    comparison,
    warning:
      !comparison.withinThreshold && policy === "match_longest_media"
        ? `Audio and timeline differ by ${deltaSec}s; exporting to the longer ${longest}s. Align the audio for a tighter final cut.`
        : undefined,
  };
}

// Target word count for a narration script that should fill `targetSec`.
export function estimateWordsForDuration(
  targetSec: number,
  wordsPerSecond: number = NARRATION_WORDS_PER_SEC
): number {
  return Math.max(1, Math.round(Math.max(0, targetSec) * wordsPerSecond));
}

export function countWords(text: string): number {
  const trimmed = (text || "").trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}
