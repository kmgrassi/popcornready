import { structuredCall } from "../anthropic";
import {
  Clip,
  CriticReport,
  EditPlan,
  Patch,
  StoryContext,
  Timeline,
  TimelineSegment,
} from "../types";
import { clipCatalog, timelineForPrompt } from "../timeline";
import { storyContextForPrompt } from "../story-context";
import {
  estimateWordsForDuration,
  NARRATION_WORDS_PER_SEC,
} from "../audio-alignment";
import { videoQualityContextForPrompt } from "../video-quality-context";
import {
  criticSchema,
  narrationRewriteSchema,
  planSchema,
  reviseSchema,
  timelineSchema,
} from "./schemas";

// Shared, stable preamble. Goes in the cached system block so the four agent
// calls in one generation reuse the same cached prefix.
const PREAMBLE = `You are the editorial brain of an AI-native video editor.
You never touch raw video — you only produce and edit a structured timeline.
The timeline is a list of segments; each segment plays one clip trimmed to a
[sourceInSec, sourceOutSec] window. Segments play back-to-back in order.

Story guidance for science and educational social video:
- Win attention before explanation: one concrete question, one visual surprise,
  one immediate reason to care.
- Use a story arc, not an information dump. Favor mystery-to-model, challenge,
  visual reveal, misconception, or demo-first structures.
- Teach one big idea per asset. Reduce cognitive load with captions, concrete
  nouns, clear visual evidence, and a simple mental model.
- Earn trust after the hook with accurate wording, visible expertise, and a
  payoff that leaves the viewer smarter.

Production-value guidance:
${videoQualityContextForPrompt()}

Hard rules:
- Only ever reference clips by the exact ids in the provided catalog.
- sourceInSec/sourceOutSec must lie within that clip's duration.
- Keep segments at least ~1s long and prefer punchy cuts (1.5–4s) for social pacing.
- Maximize visual variety; avoid reusing the same clip back-to-back.
- Match clips to beats using the clip descriptions and filenames as your only
  signal about content.`;

function planText(p: EditPlan): string {
  return [
    `target length: ${p.targetLengthSec}s`,
    `style: ${p.style}`,
    `aspect ratio: ${p.aspectRatio}`,
    "beats:",
    ...p.beats.map(
      (b) => `  - ${b.name} (~${b.durationSec}s): ${b.intent}`
    ),
  ].join("\n");
}

export async function planEdit(input: {
  goal: string;
  targetLengthSec: number;
  style: string;
  aspectRatio: string;
  storyContext?: StoryContext | null;
}): Promise<EditPlan> {
  const sys = `${PREAMBLE}

TASK: Convert the user's creative goal into a beat-by-beat edit plan. Choose
beats appropriate to the goal and style (e.g. hook / problem / solution / proof
/ cta for an ad). Beat durations should roughly sum to the target length.
Make sure the plan has a clear beginning, middle, payoff, and a reason for
each scene. Avoid random shot collections.`;

  const user = `Creative goal: ${input.goal}
Target length: ${input.targetLengthSec}s
Style: ${input.style}
Aspect ratio: ${input.aspectRatio}
Story context:
${storyContextForPrompt(input.storyContext)}

Produce the edit plan.`;

  const plan = await structuredCall<EditPlan>({
    cachedSystem: sys,
    user,
    schema: planSchema,
    maxTokens: 2000,
  });
  // Honor the user's explicit aspect ratio choice.
  plan.aspectRatio = input.aspectRatio as EditPlan["aspectRatio"];
  return plan;
}

export async function selectClips(input: {
  plan: EditPlan;
  clips: Clip[];
}): Promise<Timeline> {
  const sys = `${PREAMBLE}

CLIP CATALOG:
${clipCatalog(input.clips)}

TASK: Build the first rough cut. For each beat, pick the best-matching clip(s)
and choose tight in/out points. Cover every beat; you may use multiple
segments per beat. Order segments to flow as a finished edit. Favor motivated
cuts, pacing variation, clear information flow, and visual cohesion.`;

  const user = `Edit plan:
${planText(input.plan)}

Produce the timeline segments now.`;

  const raw = await structuredCall<{
    showCaptions?: boolean;
    segments: Omit<TimelineSegment, "id">[];
  }>({
    cachedSystem: sys,
    user,
    schema: timelineSchema,
    maxTokens: 8000,
  });

  const showCaptions =
    raw.showCaptions === undefined ? undefined : Boolean(raw.showCaptions);

  return {
    aspectRatio: input.plan.aspectRatio,
    fps: 30,
    segments: raw.segments as TimelineSegment[],
    ...(showCaptions === undefined ? {} : { showCaptions }),
  };
}

export async function critique(input: {
  plan: EditPlan;
  timeline: Timeline;
  clips: Clip[];
  storyContext?: StoryContext | null;
}): Promise<{ report: CriticReport; patches: Patch[] }> {
  const sys = `${PREAMBLE}

CLIP CATALOG:
${clipCatalog(input.clips)}

TASK: You are the critic. Score the current cut 0–10 on each rubric dimension
(repetition_penalty is 0=none, 10=severe). Then output concrete timeline
patches that would improve the weakest areas. Only patch what helps; an empty
patch list is fine if the cut is already strong. Reference real segmentIds and
clipIds. Prioritize fixes that improve story clarity, momentum, purpose,
cohesion, and payoff before decorative transitions or effects.`;

const user = `Edit plan:
${planText(input.plan)}

Story context:
${storyContextForPrompt(input.storyContext)}

Current timeline:
${timelineForPrompt(input.timeline, input.clips)}

Score it and propose improvement patches.`;

  const out = await structuredCall<{
    scores: CriticReport["scores"];
    summary: string;
    patches: Patch[];
  }>({ cachedSystem: sys, user, schema: criticSchema, maxTokens: 6000 });

  return {
    report: { scores: out.scores, summary: out.summary },
    patches: out.patches,
  };
}

export async function revise(input: {
  message: string;
  plan: EditPlan | null;
  timeline: Timeline;
  clips: Clip[];
  storyContext?: StoryContext | null;
}): Promise<{ summary: string; patches: Patch[] }> {
  const sys = `${PREAMBLE}

CLIP CATALOG:
${clipCatalog(input.clips)}

TASK: The user wants to revise the current cut conversationally. Translate
their request into concrete timeline patches. Make the smallest set of changes
that satisfies the request. Reference real segmentIds and clipIds. Briefly
summarize what you changed.`;

  const user = `${input.plan ? `Edit plan:\n${planText(input.plan)}\n\n` : ""}Story context:
${storyContextForPrompt(input.storyContext)}

Current timeline:
${timelineForPrompt(input.timeline, input.clips)}

User request: "${input.message}"

Produce patches and a summary.`;

  return structuredCall<{ summary: string; patches: Patch[] }>({
    cachedSystem: sys,
    user,
    schema: reviseSchema,
    maxTokens: 6000,
  });
}

// Rewrites a narration script so that, read at a natural pace, it fills a
// target duration. Used by the audio-alignment `rewrite_script` strategy to
// fit generated narration to the visual timeline.
export async function rewriteNarrationScript(input: {
  currentScript: string;
  targetDurationSec: number;
  storyContext?: StoryContext | null;
}): Promise<{ script: string; summary: string; estimatedDurationSec: number }> {
  const targetWordCount = estimateWordsForDuration(input.targetDurationSec);
  const sys = `You rewrite voiceover narration to hit a target spoken length.
Read aloud at a natural pace of about ${NARRATION_WORDS_PER_SEC} words per second.
Rules:
- Preserve the original meaning, key facts, and tone.
- Return only the spoken words — no stage directions, timestamps, or labels.
- Do not invent claims that were not implied by the original script.
- Aim for the target word count so the audio lands within ~1 second of the target.`;

  const user = `Original narration:
"""
${input.currentScript}
"""

Story context:
${storyContextForPrompt(input.storyContext)}

Target spoken duration: ${input.targetDurationSec.toFixed(1)}s
Target length: about ${targetWordCount} words.

Rewrite the narration to fit, then report the rewritten script, your estimated
spoken duration in seconds, and a one-line summary of what changed.`;

  return structuredCall<{
    script: string;
    estimatedDurationSec: number;
    summary: string;
  }>({
    cachedSystem: sys,
    user,
    schema: narrationRewriteSchema,
    maxTokens: 2000,
  });
}
