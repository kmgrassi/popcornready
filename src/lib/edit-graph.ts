import {
  AspectRatio,
  Clip,
  EditPlan,
  StoryContext,
  Timeline,
  TimelineSegment,
} from "./types";

export const EDIT_GRAPH_SCHEMA_VERSION = "edit_graph.v1" as const;
export const EDIT_GRAPH_COMPILER_VERSION = "edit-graph-compiler.v1" as const;

export type MediaAssetType = "video" | "audio" | "image" | "text" | "generated";

export interface MediaAsset {
  id: string;
  uri: string;
  type: MediaAssetType;
  durationMs?: number;
  metadata: {
    width?: number;
    height?: number;
    fps?: number;
    sampleRate?: number;
    channels?: number;
    codec?: string;
  };
  generatedBy?: { provider: string; model?: string; prompt: string };
}

export interface MediaSegment {
  id: string;
  assetId: string;
  startMs: number;
  endMs: number;
  visualDescription?: string;
  semanticTags: string[];
}

export interface StoryPlan {
  id: string;
  objective: string;
  targetDurationMs: number;
  audience?: string;
  tone?: string;
  beats: StoryBeat[];
}

export interface StoryBeat {
  id: string;
  role: string;
  intent: string;
  targetDurationMs?: number;
}

export interface EditDecision {
  id: string;
  beatId: string;
  operation: "select_segment" | "trim" | "caption";
  sourceSegmentIds: string[];
  rationale?: string;
  confidence?: number;
  timelineSegmentId: string;
  caption?: string;
}

export interface EditGraphTimelineProjection {
  id: string;
  derived: true;
  compilerVersion: typeof EDIT_GRAPH_COMPILER_VERSION;
  compiledAt: string;
}

export interface EditGraphDocument {
  id: string;
  schemaVersion: typeof EDIT_GRAPH_SCHEMA_VERSION;
  projectId: string;
  briefVersionId: string;
  compositionId?: string;
  assets: MediaAsset[];
  analysis: {
    segments: MediaSegment[];
  };
  intent: {
    goal: string;
    audience?: string;
    platform?: string;
    targetDurationMs?: number;
    aspectRatio?: AspectRatio;
    tone?: string;
  };
  story: StoryPlan;
  edit: {
    decisions: EditDecision[];
  };
  timeline: EditGraphTimelineProjection | null;
  createdBy: { jobId: string };
  createdAt: string;
  updatedAt: string;
}

export interface CompiledTimelineMetadata {
  editGraphId: string;
  compilerVersion: typeof EDIT_GRAPH_COMPILER_VERSION;
  compiledAt: string;
}

function secToMs(value: number): number {
  return Math.round(value * 1000);
}

function msToSec(value: number): number {
  return value / 1000;
}

function roleToBeatId(role: string): string {
  const slug = role.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `beat_${slug || "segment"}`;
}

function assetTypeFromClip(clip: Clip): MediaAssetType {
  if (clip.source === "generated") return "generated";
  if (clip.kind === "audio") return "audio";
  if (clip.kind === "image") return "image";
  return "video";
}

export function clipToMediaAsset(clip: Clip): MediaAsset {
  return {
    id: clip.id,
    uri: clip.url,
    type: assetTypeFromClip(clip),
    durationMs: secToMs(clip.measuredDurationSec ?? clip.durationSec),
    metadata: {},
    ...(clip.generatedBy
      ? {
          generatedBy: {
            provider: clip.generatedBy.provider,
            ...(clip.generatedBy.model ? { model: clip.generatedBy.model } : {}),
            prompt: clip.generatedBy.prompt,
          },
        }
      : {}),
  };
}

export function buildEditGraphFromTimeline(args: {
  id: string;
  projectId: string;
  briefVersionId: string;
  compositionId?: string;
  jobId: string;
  goal: string;
  targetLengthSec: number;
  aspectRatio: AspectRatio;
  style?: string;
  storyContext?: StoryContext;
  plan: EditPlan;
  clips: Clip[];
  timeline: Timeline;
  createdAt: string;
}): EditGraphDocument {
  const beatById = new Map<string, StoryBeat>();
  for (const beat of args.plan.beats) {
    beatById.set(roleToBeatId(beat.name), {
      id: roleToBeatId(beat.name),
      role: beat.name,
      intent: beat.intent,
      targetDurationMs: secToMs(beat.durationSec),
    });
  }

  for (const segment of args.timeline.segments) {
    const beatId = roleToBeatId(segment.role);
    if (!beatById.has(beatId)) {
      beatById.set(beatId, {
        id: beatId,
        role: segment.role,
        intent: segment.reason || segment.role,
        targetDurationMs: secToMs(segment.sourceOutSec - segment.sourceInSec),
      });
    }
  }

  const analysisSegments: MediaSegment[] = args.timeline.segments.map((segment) => ({
    id: `media_${segment.id}`,
    assetId: segment.clipId,
    startMs: secToMs(segment.sourceInSec),
    endMs: secToMs(segment.sourceOutSec),
    semanticTags: [segment.role].filter(Boolean),
  }));

  const decisions: EditDecision[] = args.timeline.segments.map((segment) => ({
    id: `decision_${segment.id}`,
    beatId: roleToBeatId(segment.role),
    operation: segment.caption ? "caption" : "select_segment",
    sourceSegmentIds: [`media_${segment.id}`],
    rationale: segment.reason,
    timelineSegmentId: segment.id,
    ...(segment.caption ? { caption: segment.caption } : {}),
  }));

  return {
    id: args.id,
    schemaVersion: EDIT_GRAPH_SCHEMA_VERSION,
    projectId: args.projectId,
    briefVersionId: args.briefVersionId,
    ...(args.compositionId ? { compositionId: args.compositionId } : {}),
    assets: args.clips.map(clipToMediaAsset),
    analysis: { segments: analysisSegments },
    intent: {
      goal: args.goal,
      ...(args.storyContext?.audience ? { audience: args.storyContext.audience } : {}),
      ...(args.storyContext?.platform ? { platform: args.storyContext.platform } : {}),
      targetDurationMs: secToMs(args.targetLengthSec),
      aspectRatio: args.aspectRatio,
      ...(args.style ? { tone: args.style } : {}),
    },
    story: {
      id: `story_${args.id}`,
      objective: args.goal,
      targetDurationMs: secToMs(args.plan.targetLengthSec),
      ...(args.storyContext?.audience ? { audience: args.storyContext.audience } : {}),
      ...(args.style ? { tone: args.style } : {}),
      beats: [...beatById.values()],
    },
    edit: { decisions },
    timeline: null,
    createdBy: { jobId: args.jobId },
    createdAt: args.createdAt,
    updatedAt: args.createdAt,
  };
}

export function compileEditGraphToTimeline(
  graph: EditGraphDocument,
  options: { fps?: number; showCaptions?: boolean } = {}
): Timeline {
  const mediaById = new Map(graph.analysis.segments.map((segment) => [segment.id, segment]));
  const beatById = new Map(graph.story.beats.map((beat) => [beat.id, beat]));

  const segments: TimelineSegment[] = [];
  for (const decision of graph.edit.decisions) {
    const source = mediaById.get(decision.sourceSegmentIds[0]);
    if (!source) continue;
    const beat = beatById.get(decision.beatId);
    segments.push({
      id: decision.timelineSegmentId,
      clipId: source.assetId,
      sourceInSec: msToSec(source.startMs),
      sourceOutSec: msToSec(source.endMs),
      role: beat?.role ?? decision.beatId,
      reason: decision.rationale || "",
      ...(decision.caption ? { caption: decision.caption } : {}),
    });
  }

  return {
    aspectRatio: graph.intent.aspectRatio ?? "9:16",
    fps: options.fps ?? 30,
    segments,
    ...(options.showCaptions === undefined ? {} : { showCaptions: options.showCaptions }),
  };
}

export function markGraphTimelineProjection(
  graph: EditGraphDocument,
  timelineId: string,
  compiledAt: string
): EditGraphDocument {
  return {
    ...graph,
    timeline: {
      id: timelineId,
      derived: true,
      compilerVersion: EDIT_GRAPH_COMPILER_VERSION,
      compiledAt,
    },
    updatedAt: compiledAt,
  };
}
