import { getLlmClient } from "../llm";
import {
  Clip,
  CriticReport,
  EditPlan,
  Patch,
  planBeats,
  PlanCritiqueReport,
  StoryContext,
  Timeline,
  TimelineSegment,
  UploadedFootagePlanReview,
} from "@popcorn/shared/types";
import { clipCatalog, timelineForPrompt } from "@popcorn/timeline/timeline";
import {
  compileTimelineViaEditGraph,
  editGraphBeatId,
  ensureBeatIds,
} from "@popcorn/shared/edit-graph";
import { storyContextForPrompt } from "@popcorn/shared/story-context";
import {
  estimateWordsForDuration,
  NARRATION_WORDS_PER_SEC,
} from "@popcorn/shared/audio-alignment";
import { videoQualityContextForPrompt } from "@popcorn/shared/video-quality-context";
import {
  criticSchema,
  editDecisionTimelineSchema,
  narrationRewriteSchema,
  planCritiqueSchema,
  planSchema,
  reviseSchema,
  uploadedFootagePlanReviewSchema,
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
  const lines = [
    `target length: ${p.targetLengthSec}s`,
    `style: ${p.style}`,
    `aspect ratio: ${p.aspectRatio}`,
    "scenes:",
  ];
  for (const scene of p.scenes) {
    const meta = [
      scene.setting ? `setting: ${scene.setting}` : null,
      scene.mood ? `mood: ${scene.mood}` : null,
    ]
      .filter(Boolean)
      .join("; ");
    lines.push(`  - scene "${scene.name}"${meta ? ` (${meta})` : ""}`);
    for (const b of scene.beats) {
      lines.push(`      • ${b.name} (~${b.durationSec}s): ${b.intent}`);
    }
  }
  return lines.join("\n");
}

function storyPlanText(p: EditPlan): string {
  return [
    planText(p),
    "story beat ids:",
    ...planBeats(p).map(
      (beat, index) =>
        `  - ${beat.id || editGraphBeatId(index, beat.name)}: ${beat.name}`
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

TASK: Convert the user's creative goal into a storyboard plan organized as
SCENES, each containing ordered BEATS. A scene is the continuity unit — a shared
setting, cast, and look that its beats inherit; a beat is one shot (hook /
problem / solution / proof / cta for an ad, etc.). Group beats that share a
setting/look into the same scene, and start a new scene when the location, time,
or look changes. Give each scene a name plus its setting and mood, and (when the
content has recurring characters) list its characterIds. For a short, single-
setting clip you may emit a single scene containing all the beats. Beat durations
should roughly sum to the target length. Make sure the plan has a clear
beginning, middle, payoff, and a reason for each scene. Avoid random shot
collections.`;

  const user = `Creative goal: ${input.goal}
Target length: ${input.targetLengthSec}s
Style: ${input.style}
Aspect ratio: ${input.aspectRatio}
Story context:
${storyContextForPrompt(input.storyContext)}

Produce the edit plan.`;

  const plan = await getLlmClient().structured<EditPlan>({
    cachedSystem: sys,
    user,
    schema: planSchema,
    maxTokens: 2000,
    effort: "high", // creative planning: goal -> structured storyboard/beats
  });
  // Honor the user's explicit aspect ratio choice.
  plan.aspectRatio = input.aspectRatio as EditPlan["aspectRatio"];
  // Mint stable beat ids at creation so the whole chain links by id, not role.
  ensureBeatIds(plan);
  return plan;
}

export async function critiquePlan(input: {
  goal: string;
  plan: EditPlan;
  style: string;
  aspectRatio: string;
  storyContext?: StoryContext | null;
}): Promise<PlanCritiqueReport> {
  const sys = `${PREAMBLE}

TASK: Review the edit plan before any image or video generation happens.
This is the last cheap checkpoint before expensive provider calls.

Look for:
- weak or incoherent story arc
- beat order that will produce a random montage instead of a sequence
- ambiguous pronouns or missing character identity details
- beat intents that lack enough concrete visual context for generation
- impossible requests for short clips
- timing that cannot support the requested story

Return a revised plan that is ready for generation. Keep the user's core idea,
target length, style, and aspect ratio. Prefer direct revisions over vague
advice.`;

  const user = `Creative goal:
${input.goal}

Target style: ${input.style}
Aspect ratio: ${input.aspectRatio}

Story context:
${storyContextForPrompt(input.storyContext)}

Draft edit plan:
${planText(input.plan)}

Critique and revise this plan before media generation.`;

  const report = await getLlmClient().structured<PlanCritiqueReport>({
    cachedSystem: sys,
    user,
    schema: planCritiqueSchema,
    maxTokens: 4000,
    effort: "medium", // judgement, but bounded
  });

  report.revisedPlan.targetLengthSec = input.plan.targetLengthSec;
  report.revisedPlan.style = input.style;
  report.revisedPlan.aspectRatio = input.aspectRatio as EditPlan["aspectRatio"];
  // The revised plan is a fresh plan; ensure its beats are addressable.
  ensureBeatIds(report.revisedPlan);
  return report;
}

export async function critiqueUploadedFootagePlan(input: {
  goal: string;
  plan: EditPlan;
  style: string;
  aspectRatio: string;
  storyContext?: StoryContext | null;
  clips: Clip[];
  allowGeneratedGapFill: boolean;
}): Promise<UploadedFootagePlanReview> {
  const sys = `${PREAMBLE}

CLIP CATALOG:
${clipCatalog(input.clips)}

TASK: Review the edit plan before timeline assembly for an uploaded-footage
edit. Judge whether the selected source footage can cover the requested story,
which beats are missing or weak, and whether the plan should be revised to fit
the source catalog. Do not invent new source assets. If generated gap fill is
not allowed, prefer a revised uploaded-only plan that honestly uses available
footage.`;

  const user = `Creative goal:
${input.goal}

Target style: ${input.style}
Aspect ratio: ${input.aspectRatio}
Generated gap fill allowed: ${input.allowGeneratedGapFill ? "yes" : "no"}

Story context:
${storyContextForPrompt(input.storyContext)}

Draft edit plan:
${planText(input.plan)}

Review source coverage and return a revised plan for the timeline selector.`;

  const report = await getLlmClient().structured<UploadedFootagePlanReview>({
    cachedSystem: sys,
    user,
    schema: uploadedFootagePlanReviewSchema,
    maxTokens: 4000,
    effort: "medium", // judgement, but bounded
  });

  report.revisedPlan.targetLengthSec = input.plan.targetLengthSec;
  report.revisedPlan.style = input.style;
  report.revisedPlan.aspectRatio = input.aspectRatio as EditPlan["aspectRatio"];
  ensureBeatIds(report.revisedPlan);
  return report;
}

export async function selectClips(input: {
  plan: EditPlan;
  clips: Clip[];
  goal?: string;
  storyContext?: StoryContext | null;
}): Promise<Timeline> {
  const sys = `${PREAMBLE}

CLIP CATALOG:
${clipCatalog(input.clips)}

TASK: Build the first rough cut as edit decisions. For each story beat id, pick
the best-matching clip(s), choose tight in/out points, and explain the rationale.
Cover every beat; you may use multiple decisions per beat. Order decisions to
flow as a finished edit. Favor motivated cuts, pacing variation, clear
information flow, and visual cohesion.`;

  const user = `Edit plan:
${storyPlanText(input.plan)}

Produce the edit decisions now.`;

  const raw = await getLlmClient().structured<{
    showCaptions?: boolean;
    decisions: {
      beatId: string;
      clipId: string;
      sourceInSec: number;
      sourceOutSec: number;
      rationale: string;
      caption?: string;
    }[];
  }>({
    cachedSystem: sys,
    user,
    schema: editDecisionTimelineSchema,
    maxTokens: 8000,
    effort: "medium", // match beats to clips + in/out points
  });

  const showCaptions =
    raw.showCaptions === undefined ? undefined : Boolean(raw.showCaptions);

  const beatsById = new Map(
    planBeats(input.plan).map((beat, index) => [
      beat.id || editGraphBeatId(index, beat.name),
      beat,
    ])
  );
  const timeline: Timeline = {
    aspectRatio: input.plan.aspectRatio,
    fps: 30,
    segments: raw.decisions.map((decision, index) => {
      const beat = beatsById.get(decision.beatId);
      return {
        id: `seg_${index + 1}`,
        clipId: decision.clipId,
        sourceInSec: decision.sourceInSec,
        sourceOutSec: decision.sourceOutSec,
        role: beat?.name || decision.beatId,
        beatId: beat?.id || decision.beatId,
        reason: decision.rationale,
        ...(decision.caption === undefined ? {} : { caption: decision.caption }),
      };
    }) as TimelineSegment[],
    ...(showCaptions === undefined ? {} : { showCaptions }),
  };

  return compileTimelineViaEditGraph({
    id: "rough_cut",
    goal: input.goal || planBeats(input.plan).map((beat) => beat.intent).join(" "),
    plan: input.plan,
    timeline,
    clips: input.clips,
    storyContext: input.storyContext,
  });
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

  const out = await getLlmClient().structured<{
    scores: CriticReport["scores"];
    summary: string;
    patches: Patch[];
  }>({ cachedSystem: sys, user, schema: criticSchema, maxTokens: 6000, effort: "medium" });

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

  return getLlmClient().structured<{ summary: string; patches: Patch[] }>({
    cachedSystem: sys,
    user,
    schema: reviseSchema,
    maxTokens: 6000,
    effort: "medium", // chat note -> targeted timeline patches
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

  return getLlmClient().structured<{
    script: string;
    estimatedDurationSec: number;
    summary: string;
  }>({
    cachedSystem: sys,
    user,
    schema: narrationRewriteSchema,
    maxTokens: 2000,
    effort: "low", // text rewrite to a length target — not deep reasoning
  });
}
