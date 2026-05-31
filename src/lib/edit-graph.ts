import { Clip, Patch, Timeline, TimelineSegment } from "./types";

export const EDIT_GRAPH_SCHEMA_VERSION = "edit-graph.v1" as const;

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

export interface EditDecisionNode {
  id: string;
  beatId: string;
  operation: "select_segment";
  sourceSegmentIds: string[];
  outputSegment: TimelineSegment;
  rationale?: string;
  confidence?: number;
  alternatives?: EditGraphAlternative[];
}

export interface EditGraph {
  schemaVersion: typeof EDIT_GRAPH_SCHEMA_VERSION;
  timelineProjection: Pick<Timeline, "aspectRatio" | "fps" | "showCaptions">;
  edit: {
    decisions: EditDecisionNode[];
    revisionOperations: EditGraphRevisionOperation[];
  };
}

function newId(prefix: string): string {
  return `${prefix}_` + Math.random().toString(36).slice(2, 10);
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

function operationTargetLayer(patch: Patch): EditGraphLayer {
  switch (patch.op) {
    case "set_caption":
      return "edit";
    case "reorder":
    case "add_segment":
    case "remove_segment":
    case "replace_clip":
    case "set_trim":
    default:
      return "edit";
  }
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

export function createEditGraphFromTimeline(timeline: Timeline): EditGraph {
  return {
    schemaVersion: EDIT_GRAPH_SCHEMA_VERSION,
    timelineProjection: {
      aspectRatio: timeline.aspectRatio,
      fps: timeline.fps,
      ...(timeline.showCaptions === undefined
        ? {}
        : { showCaptions: timeline.showCaptions }),
    },
    edit: {
      decisions: timeline.segments.map((segment) => ({
        id: `decision_${segment.id}`,
        beatId: segment.role || "unassigned",
        operation: "select_segment",
        sourceSegmentIds: [segment.id],
        outputSegment: { ...segment },
        rationale: segment.reason,
        confidence: 1,
      })),
      revisionOperations: [],
    },
  };
}

export function compileEditGraph(graph: EditGraph): Timeline {
  return {
    aspectRatio: graph.timelineProjection.aspectRatio,
    fps: graph.timelineProjection.fps,
    segments: graph.edit.decisions.map((decision) => ({
      ...decision.outputSegment,
    })),
    ...(graph.timelineProjection.showCaptions === undefined
      ? {}
      : { showCaptions: graph.timelineProjection.showCaptions }),
  };
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
  const clipIds = new Set(input.clips.map((clip) => clip.id));
  let decisions: EditDecisionNode[] = input.graph.edit.decisions.map((decision) => ({
    ...decision,
    outputSegment: { ...decision.outputSegment },
    alternatives: decision.alternatives?.map((alternative) => ({ ...alternative })),
  }));

  for (const operation of input.operations) {
    const patch = operation.patch;
    switch (patch.op) {
      case "set_trim":
        decisions = decisions.map((decision) =>
          decision.outputSegment.id === patch.segmentId
            ? {
                ...decision,
                outputSegment: {
                  ...decision.outputSegment,
                  sourceInSec: patch.sourceInSec,
                  sourceOutSec: patch.sourceOutSec,
                  reason: patch.reason,
                },
                rationale: patch.reason,
                alternatives: operation.alternatives,
              }
            : decision
        );
        break;
      case "replace_clip":
        if (!clipIds.has(patch.newClipId)) break;
        decisions = decisions.map((decision) =>
          decision.outputSegment.id === patch.segmentId
            ? {
                ...decision,
                sourceSegmentIds: [patch.segmentId],
                outputSegment: {
                  ...decision.outputSegment,
                  clipId: patch.newClipId,
                  sourceInSec: patch.sourceInSec,
                  sourceOutSec: patch.sourceOutSec,
                  reason: patch.reason,
                },
                rationale: patch.reason,
                alternatives: operation.alternatives,
              }
            : decision
        );
        break;
      case "remove_segment":
        decisions = decisions.filter(
          (decision) => decision.outputSegment.id !== patch.segmentId
        );
        break;
      case "set_caption":
        decisions = decisions.map((decision) =>
          decision.outputSegment.id === patch.segmentId
            ? {
                ...decision,
                outputSegment: {
                  ...decision.outputSegment,
                  caption: patch.caption,
                  reason: decision.outputSegment.reason || patch.reason,
                },
                rationale: patch.reason,
                alternatives: operation.alternatives,
              }
            : decision
        );
        break;
      case "reorder": {
        const position = new Map(
          patch.segmentIdsInOrder.map((segmentId, index) => [segmentId, index])
        );
        decisions = [...decisions].sort(
          (a, b) =>
            (position.has(a.outputSegment.id)
              ? position.get(a.outputSegment.id)!
              : 1e9) -
            (position.has(b.outputSegment.id)
              ? position.get(b.outputSegment.id)!
              : 1e9)
        );
        break;
      }
      case "add_segment": {
        if (!clipIds.has(patch.clipId)) break;
        const segment: TimelineSegment = {
          id: newId("seg"),
          clipId: patch.clipId,
          sourceInSec: patch.sourceInSec,
          sourceOutSec: patch.sourceOutSec,
          role: patch.role,
          reason: patch.reason,
        };
        const decision: EditDecisionNode = {
          id: newId("decision"),
          beatId: patch.role || "unassigned",
          operation: "select_segment",
          sourceSegmentIds: [segment.id],
          outputSegment: segment,
          rationale: patch.reason,
          confidence: 1,
          alternatives: operation.alternatives,
        };
        if (patch.afterSegmentId === null) {
          decisions = [decision, ...decisions];
        } else {
          const index = decisions.findIndex(
            (candidate) => candidate.outputSegment.id === patch.afterSegmentId
          );
          decisions =
            index === -1
              ? [...decisions, decision]
              : [
                  ...decisions.slice(0, index + 1),
                  decision,
                  ...decisions.slice(index + 1),
                ];
        }
        break;
      }
    }
  }

  return {
    ...input.graph,
    edit: {
      decisions,
      revisionOperations: [
        ...input.graph.edit.revisionOperations,
        ...input.operations,
      ],
    },
  };
}
