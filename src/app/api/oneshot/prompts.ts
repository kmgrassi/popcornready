import { AspectRatio, Beat, EditPlan } from "@/lib/types";
import { videoQualityContextForPrompt } from "@/lib/video-quality-context";
import { requestFingerprint } from "@/lib/provenance";

function characterContinuityBlock(goal: string): string {
  const ageMatch = goal.match(/\b(\d{1,2})[- ]year[- ]old\b/i);
  const age = ageMatch ? `${ageMatch[1]}-year-old` : "same";
  const roleMatch = goal.match(
    /\b(?:\d{1,2}[- ]year[- ]old\s+)?([a-z][a-z -]{1,40}?(?:boy|girl|child|kid|man|woman|filmmaker|creator|founder|teacher|student))\b/i
  );
  const role = roleMatch ? roleMatch[1].trim() : "main character";

  return [
    "[CHARACTER INVARIANTS]",
    `The recurring protagonist is the same ${age} ${role} in every shot, including dream/future sequences.`,
    "Keep the same face, age, hair, build, silhouette, skin tone, wardrobe anchors, emotional throughline, and live-action cinematic style across all generated clips.",
    "Do not redesign, recast, age-shift, gender-swap, or replace the protagonist. Future/famous versions must clearly read as the same person imagined forward, not a different adult.",
  ].join(" ");
}

function beatMapForPrompt(plan: EditPlan): string {
  return plan.beats
    .map((beat, index) => `${index + 1}. ${beat.name}: ${beat.intent}`)
    .join(" ");
}

export function beatPrompt(
  goal: string,
  plan: EditPlan,
  beat: Beat,
  beatIndex: number,
  style: string,
  ar: AspectRatio
): string {
  const previousBeat = beatIndex > 0 ? plan.beats[beatIndex - 1] : null;
  const nextBeat =
    beatIndex < plan.beats.length - 1 ? plan.beats[beatIndex + 1] : null;
  return [
    `${style} cinematic live-action video clip with natural motion and camera movement for a ${ar} short-form video.`,
    characterContinuityBlock(goal),
    "[FULL STORY ARC]",
    goal,
    "[FULL BEAT MAP]",
    beatMapForPrompt(plan),
    "[CURRENT SHOT DELTA]",
    `This is beat ${beatIndex + 1} of ${plan.beats.length}: ${beat.name} — ${beat.intent}.`,
    previousBeat
      ? `The previous beat was "${previousBeat.name}" — ${previousBeat.intent}. Preserve continuity from that moment.`
      : "This is the opening beat. Establish the protagonist clearly and cinematically.",
    nextBeat
      ? `The next beat will be "${nextBeat.name}" — ${nextBeat.intent}. End with visual momentum that can cut into it.`
      : "This is the closing beat. Resolve the story clearly.",
    "Use explicit nouns instead of pronouns: show the same movie-loving boy/protagonist from the story, not an unrelated person.",
    `Production quality guidance: ${videoQualityContextForPrompt()}`,
    `Make the shot feel designed, not accidental: strong visual hierarchy, controlled lighting, subject-background separation, cohesive tone, and no on-screen text.`,
  ].join(" ");
}

export function soundtrackPrompt(input: {
  goal: string;
  style: string;
  targetLengthSec: number;
  beats: Beat[];
}): string {
  const beatSummary = input.beats
    .map((beat) => `${beat.name}: ${beat.intent}`)
    .join(" / ");
  return [
    `Create an instrumental soundtrack for this ${input.targetLengthSec}-second video.`,
    `Choose the musical style, instrumentation, tempo, and emotional arc that best fit the creative brief. Do not add vocals.`,
    `Creative brief: ${input.goal}`,
    `Visual style: ${input.style}`,
    `Story beats: ${beatSummary}`,
    `The music should support the edit, rise and fall with the scene progression, and leave room for future dialogue or narration.`,
  ].join(" ");
}

// Reuse key for a cached soundtrack: the canonical hash of the stable, user-
// controlled request inputs. The story beats are deliberately EXCLUDED — they
// are re-planned non-deterministically by the LLM on every run, so folding them
// in would needlessly invalidate a perfectly good track each resume. This
// generalises the old goal-equality + duration-tolerance + style-substring
// check into one exact comparison (goal is now inside the hash). See
// docs/scopes/north-star-provenance-graph.md task #7.
export function soundtrackRequestFingerprint(input: {
  goal: string;
  style: string;
  targetLengthSec: number;
}): string {
  return requestFingerprint({
    kind: "soundtrack",
    goal: input.goal,
    style: input.style,
    targetLengthSec: input.targetLengthSec,
  });
}
