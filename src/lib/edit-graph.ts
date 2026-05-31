import {
  AspectRatio,
  Clip,
  EditPlan,
  Patch,
  StoryContext,
  Timeline,
  TimelineSegment,
} from "./types";

export const EDIT_GRAPH_SCHEMA_VERSION = "editGraph.v1" as const;
export const EDIT_GRAPH_COMPILER_VERSION = "edit-graph-compiler.v1" as const;

export type EditGraphLayer = "story" | "analysis" | "edit" | "timeline";

export interface EditGraphAlternative {
  id: string;
  summary: string;
  score: number;
  patch: Patch;
}

export interface EditGraphRevisionOperation {
  id: string;
  targetLayer: EditGraphLayer;
  patch: Patch;
  rationale: string;
  alternatives: EditGraphAlternative[];
}

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
  alternatives?: EditGraphAlternative[];
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
    revisionOperations: EditGraphRevisionOperation[];
  };
  timelineSettings: {
    aspectRatio: AspectRatio;
    fps: number;
    showCaptions?: boolean;
  };
}

export interface EditGraphTimelineProjection {
  id: string;
  derived: true;
  compilerVersion: typeof EDIT_GRAPH_COMPILER_VERSION;
  compiledAt: string;
}

export interface EditGraphDocument extends EditGraph {
  projectId: string;
  briefVersionId: string;
  compositionId?: string;
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

export function msToSec(ms: number): number {
  return ms / 1000;
}

export function secToMs(sec: number): number {
  return Math.round(sec * 1000);
}

function newId(prefix: string): string {
  return `${prefix}_` + Math.random().toString(36).slice(2, 10);
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

function defaultPlanForTimeline(timeline: Timeline): EditPlan {
  const beatsByRole = new Map<string, number>();
  for (const segment of timeline.segments) {
    const durationSec = Math.max(0, segment.sourceOutSec - segment.sourceInSec);
    beatsByRole.set(segment.role, (beatsByRole.get(segment.role) ?? 0) + durationSec);
  }

  const beats = [...beatsByRole.entries()].map(([role, durationSec]) => ({
    name: role || "timeline",
    durationSec,
    intent: role || "Preserve the current edit.",
  }));

  return {
    targetLengthSec: beats.reduce((sum, beat) => sum + beat.durationSec, 0),
    style: "current",
    aspectRatio: timeline.aspectRatio,
    beats,
  };
}

function segmentForPatch(
  timeline: Timeline,
  patch: Patch
): TimelineSegment | undefined {
  if ("segmentId" in patch) {
    return timeline.segments.find((segment) => segment.id === patch.segmentId);
  }
  return undefined;
}

function operationTargetLayer(_patch: Patch): EditGraphLayer {
  return "edit";
}

function describePatch(patch: Patch): string {
  switch (patch.op) {
    case "set_trim":
      return `Trim ${patch.segmentId} to ${patch.sourceInSec.toFixed(2)}s-${patch.sourceOutSec.toFixed(2)}s.`;
    case "replace_clip":
      return `Replace ${patch.segmentId} with ${patch.newClipId}.`;
    case "remove_segment":
      return `Remove ${patch.segmentId}.`;
    case "reorder":
      return `Reorder ${patch.segmentIdsInOrder.length} segment(s).`;
    case "add_segment":
      return `Add ${patch.clipId} after ${patch.afterSegmentId ?? "the start"}.`;
    case "set_caption":
      return `Set caption on ${patch.segmentId}.`;
  }
}

function keepCurrentAlternative(
  segment: TimelineSegment | undefined,
  patch: Patch
): EditGraphAlternative | null {
  if (!segment) return null;
  let currentPatch: Patch | null = null;

  switch (patch.op) {
    case "set_trim":
      currentPatch = {
        ...patch,
        sourceInSec: segment.sourceInSec,
        sourceOutSec: segment.sourceOutSec,
        reason: "Keep the current trim.",
      };
      break;
    case "replace_clip":
      currentPatch = {
        ...patch,
        newClipId: segment.clipId,
        sourceInSec: segment.sourceInSec,
        sourceOutSec: segment.sourceOutSec,
        reason: "Keep the current source clip.",
      };
      break;
    case "set_caption":
      currentPatch = {
        ...patch,
        caption: segment.caption ?? "",
        reason: "Keep the current caption.",
      };
      break;
    default:
      break;
  }

  if (!currentPatch) return null;
  return {
    id: newId("alt"),
    summary: "Keep current edit",
    score: 0.5,
    patch: currentPatch,
  };
}

function cloneGraph(graph: EditGraph): EditGraph {
  return {
    ...graph,
    assets: graph.assets.map((asset) => ({ ...asset })),
    analysis: {
      segments: graph.analysis.segments.map((segment) => ({ ...segment })),
    },
    edit: {
      decisions: graph.edit.decisions.map((decision) => ({
        ...decision,
        sourceSegmentIds: [...decision.sourceSegmentIds],
        alternatives: decision.alternatives?.map((alternative) => ({
          ...alternative,
        })),
      })),
      revisionOperations: [...(graph.edit.revisionOperations ?? [])],
    },
  };
}

function addAssetIfMissing(graph: EditGraph, clip: Clip): void {
  if (graph.assets.some((asset) => asset.id === clip.id)) return;
  graph.assets.push({
    id: clip.id,
    uri: clip.url,
    type: clipType(clip),
    durationMs: secToMs(clip.measuredDurationSec ?? clip.durationSec),
    metadata: {},
    ...(clip.generatedBy ? { generatedBy: clip.generatedBy } : {}),
  });
}

function findDecision(
  graph: EditGraph,
  segmentId: string
): EditGraphDecision | undefined {
  return graph.edit.decisions.find(
    (decision) => decision.timelineSegmentId === segmentId
  );
}

function sourceForDecision(
  graph: EditGraph,
  decision: EditGraphDecision
): EditGraphMediaSegment | undefined {
  return graph.analysis.segments.find(
    (segment) => segment.id === decision.sourceSegmentIds[0]
  );
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
      revisionOperations: [],
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

export function createEditGraphFromTimeline(
  timeline: Timeline,
  clips: Clip[] = [],
  plan: EditPlan = defaultPlanForTimeline(timeline)
): EditGraph {
  return synthesizeEditGraph({
    id: newId("graph"),
    goal: "Revise timeline",
    plan,
    timeline,
    clips,
  });
}

export function buildEditGraphFromTimeline(input: {
  id: string;
  projectId: string;
  briefVersionId: string;
  compositionId?: string;
  jobId: string;
  goal: string;
  plan: EditPlan;
  timeline: Timeline;
  clips?: Clip[];
  storyContext?: StoryContext | null;
  createdAt: string;
}): EditGraphDocument {
  return {
    ...synthesizeEditGraph(input),
    projectId: input.projectId,
    briefVersionId: input.briefVersionId,
    ...(input.compositionId ? { compositionId: input.compositionId } : {}),
    timeline: null,
    createdBy: { jobId: input.jobId },
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
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

export function compileEditGraph(graph: EditGraph): Timeline {
  return compileEditGraphToTimeline(graph);
}

export function compileTimelineViaEditGraph(
  input: Parameters<typeof synthesizeEditGraph>[0]
): Timeline {
  return compileEditGraphToTimeline(synthesizeEditGraph(input));
}

export function patchesToEditGraphOperations(input: {
  timeline: Timeline;
  patches: Patch[];
}): EditGraphRevisionOperation[] {
  return input.patches.map((patch) => {
    const chosen: EditGraphAlternative = {
      id: newId("alt"),
      summary: describePatch(patch),
      score: 1,
      patch,
    };
    const current = keepCurrentAlternative(segmentForPatch(input.timeline, patch), patch);
    return {
      id: newId("gop"),
      targetLayer: operationTargetLayer(patch),
      patch,
      rationale: patch.reason,
      alternatives: current ? [chosen, current] : [chosen],
    };
  });
}

export function applyEditGraphRevisionOperations(input: {
  graph: EditGraph;
  operations: EditGraphRevisionOperation[];
  clips: Clip[];
}): EditGraph {
  const clipById = new Map(input.clips.map((clip) => [clip.id, clip]));
  const graph = cloneGraph(input.graph);

  for (const operation of input.operations) {
    const patch = operation.patch;
    switch (patch.op) {
      case "set_trim": {
        const decision = findDecision(graph, patch.segmentId);
        const source = decision ? sourceForDecision(graph, decision) : undefined;
        if (!decision || !source) break;
        source.startMs = secToMs(patch.sourceInSec);
        source.endMs = secToMs(patch.sourceOutSec);
        decision.alternatives = operation.alternatives;
        break;
      }
      case "replace_clip": {
        const clip = clipById.get(patch.newClipId);
        const decision = findDecision(graph, patch.segmentId);
        const source = decision ? sourceForDecision(graph, decision) : undefined;
        if (!clip || !decision || !source) break;
        addAssetIfMissing(graph, clip);
        source.assetId = patch.newClipId;
        source.startMs = secToMs(patch.sourceInSec);
        source.endMs = secToMs(patch.sourceOutSec);
        source.semanticTags = [decision.role, clip.description].filter(Boolean);
        decision.rationale = patch.reason;
        decision.alternatives = operation.alternatives;
        break;
      }
      case "remove_segment":
        graph.edit.decisions = graph.edit.decisions.filter(
          (decision) => decision.timelineSegmentId !== patch.segmentId
        );
        break;
      case "set_caption": {
        const decision = findDecision(graph, patch.segmentId);
        if (!decision) break;
        decision.caption = patch.caption;
        decision.alternatives = operation.alternatives;
        break;
      }
      case "reorder": {
        const position = new Map(
          patch.segmentIdsInOrder.map((segmentId, index) => [segmentId, index])
        );
        graph.edit.decisions = [...graph.edit.decisions].sort(
          (a, b) =>
            (a.timelineSegmentId && position.has(a.timelineSegmentId)
              ? position.get(a.timelineSegmentId)!
              : 1e9) -
            (b.timelineSegmentId && position.has(b.timelineSegmentId)
              ? position.get(b.timelineSegmentId)!
              : 1e9)
        );
        break;
      }
      case "add_segment": {
        const clip = clipById.get(patch.clipId);
        if (!clip) break;
        addAssetIfMissing(graph, clip);
        const segmentId = newId("seg");
        const mediaSegmentId = newId("media");
        const beat =
          graph.story.beats.find((candidate) => candidate.role === patch.role) ??
          graph.story.beats[0];
        graph.analysis.segments.push({
          id: mediaSegmentId,
          assetId: patch.clipId,
          startMs: secToMs(patch.sourceInSec),
          endMs: secToMs(patch.sourceOutSec),
          semanticTags: [patch.role, clip.description].filter(Boolean),
        });
        const decision: EditGraphDecision = {
          id: newId("decision"),
          operation: "select_segment",
          beatId: beat?.id ?? beatId(0, patch.role || "timeline"),
          role: patch.role,
          sourceSegmentIds: [mediaSegmentId],
          timelineSegmentId: segmentId,
          rationale: patch.reason,
          alternatives: operation.alternatives,
        };
        if (patch.afterSegmentId === null) {
          graph.edit.decisions = [decision, ...graph.edit.decisions];
        } else {
          const index = graph.edit.decisions.findIndex(
            (candidate) => candidate.timelineSegmentId === patch.afterSegmentId
          );
          graph.edit.decisions =
            index === -1
              ? [...graph.edit.decisions, decision]
              : [
                  ...graph.edit.decisions.slice(0, index + 1),
                  decision,
                  ...graph.edit.decisions.slice(index + 1),
                ];
        }
        break;
      }
    }
  }

  graph.edit.revisionOperations = [
    ...(graph.edit.revisionOperations ?? []),
    ...input.operations,
  ];
  return graph;
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
