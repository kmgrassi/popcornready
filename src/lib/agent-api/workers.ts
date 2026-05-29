// Job workers for the /api/v1 agent surface.
//
// PR6 implements two workers:
//   - runRevisionJob: wired to the real editorial agent (revise + applyPatches).
//   - runExportJob:   a skeleton that validates the request, resolves the
//                     export duration policy, and emits a pending_render
//                     artifact. Real rendering is deferred (see below).
//
// Both accept injectable dependencies so the smoke test can run them with mock
// providers and without network or Remotion.

import { revise as defaultRevise } from "../agent";
import { applyPatches as defaultApplyPatches } from "../timeline";
import { Clip, Project, timelineDurationSec } from "../types";
import { ApiError, newId } from "./runtime";
import {
  Artifact,
  DURATION_POLICIES,
  DurationPolicy,
  ExportRenderPlan,
  RevisionJobResult,
} from "./types";

// ---------------------------------------------------------------------------
// Revision job (implemented)
// ---------------------------------------------------------------------------

export interface RevisionDeps {
  revise: typeof defaultRevise;
  applyPatches: typeof defaultApplyPatches;
}

export async function runRevisionJob(input: {
  project: Project;
  timelineId: string;
  message: string;
  deps?: Partial<RevisionDeps>;
}): Promise<RevisionJobResult> {
  const revise = input.deps?.revise ?? defaultRevise;
  const applyPatches = input.deps?.applyPatches ?? defaultApplyPatches;

  const message = input.message.trim();
  if (!message) {
    throw new ApiError("invalid_request", 400, "Revision message is required.");
  }

  // The single-project store holds one timeline, so the requested timelineId
  // resolves to project.timeline. TODO(PR4): look up an addressable Timeline
  // resource by id and create the revision as a true sibling timeline.
  const base = input.project.timeline;
  if (!base || base.segments.length === 0) {
    throw new ApiError(
      "timeline_not_ready",
      409,
      "The project has no generated timeline to revise yet.",
      { timelineId: input.timelineId }
    );
  }

  const { summary, patches } = await revise({
    message,
    plan: input.project.plan,
    timeline: base,
    clips: input.project.clips,
    storyContext: input.project.storyContext,
  });

  // Derive the sibling cut without mutating the base timeline.
  const timeline = applyPatches(base, patches, input.project.clips);
  return { timeline, appliedPatches: patches.length, patches, summary };
}

// ---------------------------------------------------------------------------
// Export job (skeleton)
// ---------------------------------------------------------------------------

export interface ExportOptions {
  format?: string;
  quality?: string;
  audioAssetIds?: string[];
  // Defaults to match_longest_media: until audio alignment (PR5) exists this is
  // safer than silently truncating narration. TODO(PR5): default generated
  // narration to fail_on_mismatch once alignment can guarantee a fit.
  durationPolicy?: DurationPolicy;
  maxDeltaSec?: number;
}

// Pure duration resolver — covered directly by the smoke test.
export function resolveExportDuration(input: {
  timelineDurationSec: number;
  audioDurationSec: number;
  policy: DurationPolicy;
  maxDeltaSec?: number;
}): { durationSec: number; mismatch: boolean; deltaSec: number } {
  const t = input.timelineDurationSec;
  const a = input.audioDurationSec;
  const deltaSec = Math.abs(t - a);
  const mismatch = a > 0 && deltaSec > (input.maxDeltaSec ?? 1.0);

  switch (input.policy) {
    case "match_longest_media":
      return { durationSec: Math.max(t, a), mismatch, deltaSec };
    case "timeline_only":
    case "fail_on_mismatch":
    default:
      return { durationSec: t, mismatch, deltaSec };
  }
}

export function runExportJob(input: {
  project: Project;
  timelineId: string;
  options?: ExportOptions;
}): { artifact: Artifact } {
  const options = input.options ?? {};
  const format = options.format ?? "mp4";
  if (format !== "mp4") {
    throw new ApiError("unsupported_format", 400, `Unsupported export format: ${format}.`, {
      supported: ["mp4"],
    });
  }

  const timeline = input.project.timeline;
  if (!timeline || timeline.segments.length === 0) {
    throw new ApiError(
      "timeline_not_ready",
      409,
      "Nothing to export — generate a timeline first.",
      { timelineId: input.timelineId }
    );
  }

  const audioAssetIds = options.audioAssetIds ?? [];
  const audioClips: Clip[] = [];
  for (const id of audioAssetIds) {
    const clip = input.project.clips.find((c) => c.id === id);
    if (!clip) {
      throw new ApiError("asset_not_found", 404, "Audio asset not found.", {
        assetId: id,
      });
    }
    if (clip.kind !== "audio") {
      throw new ApiError(
        "invalid_request",
        400,
        "Selected asset is not an audio clip.",
        { assetId: id, kind: clip.kind ?? "video" }
      );
    }
    audioClips.push(clip);
  }

  // Reject unknown policies (e.g. a misspelled "fail_on_mismtach") instead of
  // silently falling through to timeline-only behavior, which would defeat a
  // caller's intended fail_on_mismatch guard.
  const requestedPolicy = options.durationPolicy;
  if (
    requestedPolicy !== undefined &&
    !DURATION_POLICIES.includes(requestedPolicy)
  ) {
    throw new ApiError(
      "unsupported_duration_policy",
      400,
      `Unsupported durationPolicy: ${requestedPolicy}.`,
      { supported: DURATION_POLICIES }
    );
  }
  const policy: DurationPolicy = requestedPolicy ?? "match_longest_media";
  const tDuration = timelineDurationSec(timeline);
  // TODO(PR5): use measured actual audio duration from the audio_alignment
  // step instead of the registered clip duration.
  const aDuration = audioClips.reduce((max, c) => Math.max(max, c.durationSec), 0);
  const resolved = resolveExportDuration({
    timelineDurationSec: tDuration,
    audioDurationSec: aDuration,
    policy,
    maxDeltaSec: options.maxDeltaSec,
  });

  if (policy === "fail_on_mismatch" && resolved.mismatch) {
    throw new ApiError(
      "audio_timeline_mismatch",
      422,
      "Audio and timeline durations differ beyond the allowed threshold.",
      {
        timelineDurationSec: tDuration,
        audioDurationSec: aDuration,
        deltaSec: resolved.deltaSec,
        maxDeltaSec: options.maxDeltaSec ?? 1.0,
      }
    );
  }

  const renderPlan: ExportRenderPlan = {
    durationPolicy: policy,
    durationSec: resolved.durationSec,
    timelineDurationSec: tDuration,
    audioDurationSec: aDuration,
    audioAssetIds,
    format: "mp4",
    quality: options.quality ?? "standard",
  };

  // Skeleton output: the artifact is recorded but not yet rendered. TODO(PR5):
  // render the MP4 by reusing the Remotion path in src/app/api/export/route.ts,
  // honoring renderPlan.durationSec, then set status="ready" and url.
  const artifact: Artifact = {
    id: newId("art"),
    projectId: input.project.id,
    kind: "video/mp4",
    status: "pending_render",
    url: null,
    timelineId: input.timelineId,
    durationSec: resolved.durationSec,
    renderPlan,
    createdAt: new Date().toISOString(),
  };

  return { artifact };
}
