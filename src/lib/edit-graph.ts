import {
  Clip,
  EditDecision,
  EditGraph,
  EditPlan,
  StoryBeatRole,
  StoryContext,
  StoryPlan,
  Timeline,
  TimelineSegment,
} from "./types";

function stableSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "beat";
}

function storyBeatRole(name: string): StoryBeatRole {
  const normalized = stableSlug(name);
  if (normalized.includes("hook")) return "hook";
  if (normalized.includes("context")) return "context";
  if (normalized.includes("problem")) return "problem";
  if (normalized.includes("setup")) return "setup";
  if (normalized.includes("demo") || normalized.includes("solution")) return "demo";
  if (normalized.includes("evidence") || normalized.includes("proof")) return "evidence";
  if (normalized.includes("contrast")) return "contrast";
  if (normalized.includes("payoff")) return "payoff";
  if (normalized.includes("cta") || normalized.includes("call_to_action")) return "cta";
  if (normalized.includes("outro")) return "outro";
  return "custom";
}

export function storyBeatId(name: string, index: number): string {
  return `beat_${index + 1}_${stableSlug(name)}`;
}

export function storyPlanFromEditPlan(input: {
  goal: string;
  plan: EditPlan;
  storyContext?: StoryContext | null;
}): StoryPlan {
  return {
    id: "story_plan_v1",
    objective: input.goal,
    targetDurationMs: Math.round(input.plan.targetLengthSec * 1000),
    audience: input.storyContext?.audience,
    tone: input.plan.style,
    beats: input.plan.beats.map((beat, index) => ({
      id: storyBeatId(beat.name, index),
      role: storyBeatRole(beat.name),
      name: beat.name,
      intent: beat.intent,
      targetDurationMs: Math.round(beat.durationSec * 1000),
    })),
  };
}

function secondsToMs(value: number): number {
  return Math.round(value * 1000);
}

function msToSeconds(value: number): number {
  return value / 1000;
}

function decisionIdForSegment(segment: Pick<TimelineSegment, "id">, index: number): string {
  return segment.id || `seg_${index + 1}`;
}

function beatForDecision(story: StoryPlan, decision: EditDecision) {
  return story.beats.find((beat) => beat.id === decision.beatId);
}

export function editGraphFromTimeline(input: {
  goal: string;
  plan: EditPlan;
  timeline: Timeline;
  storyContext?: StoryContext | null;
}): EditGraph {
  const story = storyPlanFromEditPlan({
    goal: input.goal,
    plan: input.plan,
    storyContext: input.storyContext,
  });

  const beatsByName = new Map(story.beats.map((beat) => [beat.name, beat]));
  const decisions = input.timeline.segments.map((segment, index): EditDecision => {
    const fallbackBeat = story.beats[Math.min(index, story.beats.length - 1)];
    const beat = beatsByName.get(segment.role) || fallbackBeat;
    return {
      id: decisionIdForSegment(segment, index),
      beatId: beat?.id || storyBeatId(segment.role, index),
      operation: "select_segment",
      sourceClipId: segment.clipId,
      sourceInMs: secondsToMs(segment.sourceInSec),
      sourceOutMs: secondsToMs(segment.sourceOutSec),
      rationale: segment.reason,
      ...(segment.caption ? { caption: segment.caption } : {}),
    };
  });

  return {
    schemaVersion: "edit-graph.v1",
    story,
    decisions,
    ...(input.storyContext ? { storyContext: input.storyContext } : {}),
  };
}

export function editGraphForGeneratedBeatClips(input: {
  goal: string;
  plan: EditPlan;
  clips: Clip[];
  storyContext?: StoryContext | null;
}): EditGraph {
  const story = storyPlanFromEditPlan({
    goal: input.goal,
    plan: input.plan,
    storyContext: input.storyContext,
  });

  return {
    schemaVersion: "edit-graph.v1",
    story,
    decisions: story.beats.flatMap((beat, index): EditDecision[] => {
      const clip = input.clips[index];
      if (!clip) return [];
      return [
        {
          id: `seg_${index + 1}_${stableSlug(beat.name)}`,
          beatId: beat.id,
          operation: "select_segment",
          sourceClipId: clip.id,
          sourceInMs: 0,
          sourceOutMs: secondsToMs(clip.durationSec),
          rationale: beat.intent,
        },
      ];
    }),
    ...(input.storyContext ? { storyContext: input.storyContext } : {}),
  };
}

export function compileEditGraphToTimeline(input: {
  graph: EditGraph;
  aspectRatio: Timeline["aspectRatio"];
  fps?: number;
  showCaptions?: boolean;
}): Timeline {
  const segments = input.graph.decisions
    .filter((decision) => decision.operation === "select_segment")
    .map((decision): TimelineSegment => {
      const beat = beatForDecision(input.graph.story, decision);
      return {
        id: decision.id,
        clipId: decision.sourceClipId,
        sourceInSec: msToSeconds(decision.sourceInMs),
        sourceOutSec: msToSeconds(decision.sourceOutMs),
        role: beat?.name || decision.beatId,
        reason: decision.rationale || beat?.intent || "",
        ...(decision.caption ? { caption: decision.caption } : {}),
      };
    });

  return {
    aspectRatio: input.aspectRatio,
    fps: input.fps || 30,
    segments,
    ...(input.showCaptions === undefined ? {} : { showCaptions: input.showCaptions }),
  };
}
