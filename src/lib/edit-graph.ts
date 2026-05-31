import {
  AspectRatio,
  Clip,
  EditPlan,
  StoryContext,
  Timeline,
  TimelineSegment,
} from "./types";

export const EDIT_GRAPH_SCHEMA_VERSION = "editGraph.v1" as const;

export interface EditGraphAsset {
  id: string;
  uri: string;
  type: "video" | "audio" | "image" | "generated";
  durationMs?: number;
  metadata: Record<string, never>;
  generatedBy?: Clip["generatedBy"];
}

export interface EditGraphStoryBeat {
  id: string;
  role: string;
  intent: string;
  targetDurationMs?: number;
}

export interface EditGraphStoryPlan {
  id: string;
  objective: string;
  targetDurationMs: number;
  audience?: string;
  tone?: string;
  beats: EditGraphStoryBeat[];
}

export interface EditGraphMediaSegment {
  id: string;
  assetId: string;
  startMs: number;
  endMs: number;
  semanticTags: string[];
}

export interface EditGraphSelectSegmentDecision {
  id: string;
  operation: "select_segment";
  beatId: string;
  role: string;
  sourceSegmentIds: string[];
  timelineSegmentId?: string;
  rationale?: string;
  caption?: string;
  confidence?: number;
}

export type EditGraphDecision = EditGraphSelectSegmentDecision;

export interface EditGraph {
  id: string;
  schemaVersion: typeof EDIT_GRAPH_SCHEMA_VERSION;
  assets: EditGraphAsset[];
  analysis: {
    segments: EditGraphMediaSegment[];
  };
  intent: {
    goal: string;
    audience?: string;
    aspectRatio: AspectRatio;
    tone?: string;
    targetDurationMs?: number;
  };
  story: EditGraphStoryPlan;
  edit: {
    decisions: EditGraphDecision[];
  };
  timelineSettings: {
    aspectRatio: AspectRatio;
    fps: number;
    showCaptions?: boolean;
  };
}

export function msToSec(ms: number): number {
  return ms / 1000;
}

export function secToMs(sec: number): number {
  return Math.round(sec * 1000);
}

function clipType(clip: Clip): EditGraphAsset["type"] {
  if (clip.source === "generated") return "generated";
  return clip.kind || "video";
}

function beatId(index: number, name: string): string {
  return `beat_${index + 1}_${name || "untitled"}`;
}

function sourceSegmentId(segment: TimelineSegment, index: number): string {
  return `media_${segment.id || index + 1}`;
}

export function synthesizeEditGraph(input: {
  id: string;
  goal: string;
  plan: EditPlan;
  timeline: Timeline;
  clips?: Clip[];
  storyContext?: StoryContext | null;
}): EditGraph {
  const beatIdsByRole = new Map<string, string>();
  const beats = input.plan.beats.map((beat, index) => {
    const id = beatId(index, beat.name);
    if (!beatIdsByRole.has(beat.name)) beatIdsByRole.set(beat.name, id);
    return {
      id,
      role: beat.name,
      intent: beat.intent,
      targetDurationMs: secToMs(beat.durationSec),
    };
  });

  const fallbackBeatId = beats[0]?.id || beatId(0, "timeline");
  const clipsById = new Map((input.clips || []).map((clip) => [clip.id, clip]));
  const timelineClipIds = new Set(input.timeline.segments.map((segment) => segment.clipId));
  const clips: Clip[] =
    input.clips?.filter((clip) => timelineClipIds.has(clip.id)) ||
    [...timelineClipIds].map((clipId) => ({
      id: clipId,
      filename: clipId,
      url: clipId,
      durationSec: 0,
      description: "",
    }));

  return {
    id: input.id,
    schemaVersion: EDIT_GRAPH_SCHEMA_VERSION,
    assets: clips.map((clip) => ({
      id: clip.id,
      uri: clip.url,
      type: clipType(clip),
      durationMs: secToMs(clip.measuredDurationSec ?? clip.durationSec),
      metadata: {},
      ...(clip.generatedBy ? { generatedBy: clip.generatedBy } : {}),
    })),
    analysis: {
      segments: input.timeline.segments.map((segment, index) => {
        const clip = clipsById.get(segment.clipId);
        return {
          id: sourceSegmentId(segment, index),
          assetId: segment.clipId,
          startMs: secToMs(segment.sourceInSec),
          endMs: secToMs(segment.sourceOutSec),
          semanticTags: [segment.role, clip?.description || ""].filter(Boolean),
        };
      }),
    },
    intent: {
      goal: input.goal,
      ...(input.storyContext?.audience ? { audience: input.storyContext.audience } : {}),
      aspectRatio: input.plan.aspectRatio,
      tone: input.plan.style,
      targetDurationMs: secToMs(input.plan.targetLengthSec),
    },
    story: {
      id: `${input.id}_story`,
      objective: input.goal,
      targetDurationMs: secToMs(input.plan.targetLengthSec),
      ...(input.storyContext?.audience ? { audience: input.storyContext.audience } : {}),
      tone: input.plan.style,
      beats,
    },
    edit: {
      decisions: input.timeline.segments.map((segment, index) => ({
        id: `decision_${segment.id || index + 1}`,
        operation: "select_segment",
        beatId: beatIdsByRole.get(segment.role) || fallbackBeatId,
        role: segment.role,
        sourceSegmentIds: [sourceSegmentId(segment, index)],
        ...(segment.id ? { timelineSegmentId: segment.id } : {}),
        rationale: segment.reason,
        ...(segment.caption === undefined ? {} : { caption: segment.caption }),
      })),
    },
    timelineSettings: {
      aspectRatio: input.timeline.aspectRatio,
      fps: input.timeline.fps,
      ...(input.timeline.showCaptions === undefined
        ? {}
        : { showCaptions: input.timeline.showCaptions }),
    },
  };
}

export function compileEditGraphToTimeline(graph: EditGraph): Timeline {
  const segmentsById = new Map(
    graph.analysis.segments.map((segment) => [segment.id, segment])
  );
  const beatsById = new Map(graph.story.beats.map((beat) => [beat.id, beat]));
  const segments: TimelineSegment[] = [];

  for (const decision of graph.edit.decisions) {
    if (decision.operation !== "select_segment") continue;
    const source = segmentsById.get(decision.sourceSegmentIds[0]);
    if (!source) continue;
    const beat = beatsById.get(decision.beatId);
    segments.push({
      ...(decision.timelineSegmentId ? { id: decision.timelineSegmentId } : {}),
      clipId: source.assetId,
      sourceInSec: msToSec(source.startMs),
      sourceOutSec: msToSec(source.endMs),
      role: decision.role || beat?.role || decision.beatId,
      reason: decision.rationale || "",
      ...(decision.caption === undefined ? {} : { caption: decision.caption }),
    } as TimelineSegment);
  }

  return {
    aspectRatio: graph.timelineSettings.aspectRatio,
    fps: graph.timelineSettings.fps,
    segments,
    ...(graph.timelineSettings.showCaptions === undefined
      ? {}
      : { showCaptions: graph.timelineSettings.showCaptions }),
  };
}

export function compileTimelineViaEditGraph(
  input: Parameters<typeof synthesizeEditGraph>[0]
): Timeline {
  return compileEditGraphToTimeline(synthesizeEditGraph(input));
}
