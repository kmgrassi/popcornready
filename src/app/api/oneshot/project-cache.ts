import { promises as fs } from "fs";
import path from "path";

import { getProject, saveProject } from "@/lib/store";
import { sanitizeTimeline } from "@/lib/timeline";
import { synthesizeEditGraph } from "@/lib/edit-graph";
import {
  AspectRatio,
  CharacterProfile,
  CharacterReference,
  Clip,
  EditPlan,
  PlanCritiqueReport,
  StoryContext,
  TimelineSegment,
} from "@/lib/types";
import type { Asset, AssetSelection } from "@/lib/assets/types";
import { newId } from "./config";

export async function savePartialProject(input: {
  goal: string;
  storyContext: StoryContext;
  plan: EditPlan;
  preGenerationReview?: PlanCritiqueReport | null;
  aspectRatio: AspectRatio;
  clips: Clip[];
  soundtrack?: Clip | null;
  characterProfiles: CharacterProfile[];
  characterReferences: CharacterReference[];
  showCaptions: boolean;
  // Self-describing pooled assets (e.g. per-beat keyframes) and the active
  // selection pointers into them (asset-pool PR D). Persisted alongside clips so
  // keyframes are no longer throwaway (North Star Principle 9).
  assets?: Asset[];
  selections?: AssetSelection[];
}): Promise<void> {
  const videoClips = input.clips.filter((clip) => clip.kind === "video");
  const clips = input.soundtrack ? [...input.clips, input.soundtrack] : input.clips;
  const segments: TimelineSegment[] = videoClips.map((clip, i) => {
    const beat = input.plan.beats[i];
    return {
      id: newId("seg"),
      clipId: clip.id,
      sourceInSec: 0,
      sourceOutSec: clip.durationSec,
      role: beat?.name || `beat ${i + 1}`,
      beatId: beat?.id,
      reason: beat?.intent || clip.description,
    };
  });
  const timeline =
    segments.length > 0
      ? sanitizeTimeline(
          { aspectRatio: input.aspectRatio, fps: 30, segments },
          clips
        )
      : null;
  if (timeline) timeline.showCaptions = input.showCaptions;

  await saveProject({
    id: "default",
    goal: input.goal,
    storyContext: input.storyContext,
    editGraph: timeline
      ? synthesizeEditGraph({
          id: "oneshot_partial",
          goal: input.goal,
          plan: input.plan,
          timeline,
          clips: input.clips,
          storyContext: input.storyContext,
        })
      : undefined,
    plan: input.plan,
    timeline,
    clips,
    ...(input.assets && input.assets.length ? { assets: input.assets } : {}),
    ...(input.selections && input.selections.length
      ? { selections: input.selections }
      : {}),
    characterProfiles: input.characterProfiles,
    characterReferences: input.characterReferences,
    preGenerationReview: input.preGenerationReview || null,
    critic: null,
    chat: [],
    updatedAt: new Date().toISOString(),
  });
}

function localGeneratedPath(url: string): string | null {
  if (!url.startsWith("/generated/")) return null;
  return path.join(process.cwd(), "public", url);
}

export async function resumableClipsForGoal(goal: string): Promise<Clip[]> {
  const existing = await getProject();
  if (existing.goal !== goal || !existing.timeline) return [];
  return existing.timeline.segments
    .map((segment) => existing.clips.find((clip) => clip.id === segment.clipId))
    .filter((clip): clip is Clip => Boolean(clip && clip.kind !== "audio"));
}

// Tolerance (seconds) for treating a cached soundtrack's duration as matching
// the current request. Audio durations decoded from media bytes rarely land
// exactly on the requested length.
const SOUNDTRACK_DURATION_TOLERANCE_SEC = 1.5;

export async function resumableSoundtrackForGoal(input: {
  goal: string;
  style: string;
  targetLengthSec: number;
}): Promise<Clip | null> {
  const existing = await getProject();
  if (existing.goal !== input.goal) return null;
  // Only reuse a cached soundtrack when it still matches the current request.
  // The editor exposes target length and style independently of the brief, so
  // rerunning the same goal at a different length/style must regenerate audio
  // rather than auto-selecting a stale clip of the wrong duration.
  const candidate = existing.clips.find((clip) => clip.kind === "audio");
  if (!candidate) return null;
  const duration = candidate.measuredDurationSec ?? candidate.durationSec;
  const durationMatches =
    Math.abs(duration - input.targetLengthSec) <=
    SOUNDTRACK_DURATION_TOLERANCE_SEC;
  const styleMatches = candidate.generatedBy?.prompt
    ? candidate.generatedBy.prompt.includes(`Visual style: ${input.style}`)
    : true;
  return durationMatches && styleMatches ? candidate : null;
}

export async function resumableCharacterForGoal(goal: string): Promise<{
  profile: CharacterProfile;
  reference: CharacterReference;
  clip: Clip;
  path: string;
} | null> {
  const existing = await getProject();
  if (existing.goal !== goal) return null;
  const reference = existing.characterReferences?.find(
    (item) => item.role === "hero_frame" && item.quality === "approved"
  );
  if (!reference) return null;
  const profile = existing.characterProfiles?.find(
    (item) => item.id === reference.characterProfileId
  );
  const clip = existing.clips.find((item) => item.id === reference.assetId);
  const filePath = clip ? localGeneratedPath(clip.url) : null;
  if (!profile || !clip || !filePath) return null;
  try {
    await fs.access(filePath);
  } catch {
    return null;
  }
  return { profile, reference, clip, path: filePath };
}
