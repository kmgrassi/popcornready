import { AspectRatio, Beat, EditPlan } from "@/lib/types";
import { videoQualityContextForPrompt } from "@/lib/video-quality-context";

// Only assert visual consistency for the recurring subjects this specific shot
// actually uses — so a characterless shot never gets a spurious "protagonist."
function consistencyBlock(anchorSubjects: string[]): string | null {
  if (anchorSubjects.length === 0) return null;
  return [
    "[CONSISTENCY ANCHORS]",
    `Keep these recurring subjects visually identical to their reference frames in this shot: ${anchorSubjects.join("; ")}.`,
    "Match their identity, appearance, materials, colors, and design exactly. Do not redesign, recast, restyle, or replace them.",
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
  ar: AspectRatio,
  anchorSubjects: string[] = []
): string {
  const previousBeat = beatIndex > 0 ? plan.beats[beatIndex - 1] : null;
  const nextBeat =
    beatIndex < plan.beats.length - 1 ? plan.beats[beatIndex + 1] : null;
  const block = consistencyBlock(anchorSubjects);
  return [
    `${style} cinematic live-action video clip with natural motion and camera movement for a ${ar} short-form video.`,
    ...(block ? [block] : []),
    "[FULL STORY ARC]",
    goal,
    "[FULL BEAT MAP]",
    beatMapForPrompt(plan),
    "[CURRENT SHOT DELTA]",
    `This is beat ${beatIndex + 1} of ${plan.beats.length}: ${beat.name} — ${beat.intent}.`,
    previousBeat
      ? `The previous beat was "${previousBeat.name}" — ${previousBeat.intent}. Preserve continuity from that moment.`
      : "This is the opening beat. Establish the scene clearly and cinematically.",
    nextBeat
      ? `The next beat will be "${nextBeat.name}" — ${nextBeat.intent}. End with visual momentum that can cut into it.`
      : "This is the closing beat. Resolve the story clearly.",
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
