import { promises as fs } from "fs";
import path from "path";

import { getProject, saveProject } from "@/lib/store";
import { sanitizeTimeline } from "@/lib/timeline";
import { synthesizeEditGraph } from "@/lib/edit-graph";
import { addAsset, resolveActiveAsset, setSelection } from "@/lib/assets/pool";
import type { Asset, AssetSelection } from "@/lib/assets/types";
import { beatClipAsset, characterAnchorAsset } from "./media-generation";
import {
  AspectRatio,
  Beat,
  CharacterProfile,
  CharacterReference,
  Clip,
  EditPlan,
  PlanCritiqueReport,
  Project,
  StoryContext,
  TimelineSegment,
} from "@/lib/types";
import { newId } from "./config";
import { soundtrackRequestFingerprint } from "./prompts";

// Build the pool `assets`/`selections` contribution for the recurring character
// (asset-pool PR E): the `character_anchor` asset plus the `character_anchor`
// selection keyed by its characterId. Returns empty arrays when there is no
// anchor (e.g. character generation was skipped). Centralized so both
// `savePartialProject` and the final project assembly persist them identically.
export function characterAnchorPool(
  anchor?: Asset | null
): { assets: Asset[]; selections: AssetSelection[] } {
  if (!anchor || !anchor.depicts?.characterId) {
    return { assets: [], selections: [] };
  }
  return {
    assets: [anchor],
    selections: [
      {
        slotKind: "character_anchor",
        slotKey: anchor.depicts.characterId,
        activeAssetId: anchor.id,
      },
    ],
  };
}

// Union pooled assets/selections, deduping assets by id and selections by their
// (slotKind, slotKey) location. Earlier arguments win, so a freshly-seeded pool
// takes precedence over a re-derived contribution for the same slot/asset.
export function mergePool(
  ...pools: { assets: Asset[]; selections: AssetSelection[] }[]
): { assets: Asset[]; selections: AssetSelection[] } {
  const seenAssetIds = new Set<string>();
  const assets: Asset[] = [];
  const seenSlots = new Set<string>();
  const selections: AssetSelection[] = [];
  for (const pool of pools) {
    for (const asset of pool.assets) {
      if (seenAssetIds.has(asset.id)) continue;
      seenAssetIds.add(asset.id);
      assets.push(asset);
    }
    for (const selection of pool.selections) {
      const key = `${selection.slotKind}::${selection.slotKey}`;
      if (seenSlots.has(key)) continue;
      seenSlots.add(key);
      selections.push(selection);
    }
  }
  return { assets, selections };
}

// Pool a generated beat clip as a first-class `beat_clip` asset (Clip/Asset
// convergence): append the asset (same id as the clip, so `poolAssets` dedups the
// twin and `clips[]` stays the render shape) and point a `beat_clip` selection at
// it. Pooling it lets `saveProject`'s freezeFingerprints stamp a baseline, so the
// clip joins the candidate-stale set and the keyframe→clip ripple fires. When the
// clip is for image-to-video, run this AFTER recordFirstFrameEdge so the
// firstFrameAssetId edge is carried. Idempotent: addAsset no-ops if the clip was
// already pooled (e.g. seeded from a prior run), preserving its frozen baseline.
export function poolBeatClip(
  poolProject: Project,
  clip: Clip,
  beat: Beat,
  anchorAssetId?: string
): void {
  addAsset(
    poolProject,
    beatClipAsset(clip, beat, { projectId: poolProject.id, anchorAssetId })
  );
  if (beat.id) setSelection(poolProject, "beat_clip", beat.id, clip.id);
}

// Pool clips carried in from a resumed run. The generation loop starts at
// clips.length, so it never pools these; without this they'd reach the final save
// with no `beat_clip` asset/baseline and stay invisible to `getStaleCandidates`.
// Clips map to beats positionally (resume assumes the same goal → same arc).
export function poolResumedBeatClips(
  poolProject: Project,
  resumedClips: Clip[],
  plan: EditPlan,
  anchorAssetId?: string
): void {
  resumedClips.forEach((clip, index) => {
    const beat = plan.beats[index];
    if (beat) poolBeatClip(poolProject, clip, beat, anchorAssetId);
  });
}

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
  // The recurring character represented as a pooled `character_anchor` asset
  // (asset-pool PR E). Persisted alongside its `character_anchor` selection so
  // resume reads the active selection rather than the legacy reference scan.
  characterAnchor?: Asset | null;
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

  // The persisted pool is the union of the per-beat keyframes (PR D) and the
  // character_anchor (PR E) — both are first-class pooled assets. Deduped
  // because on resume the seeded pool already carries the persisted anchor, so
  // unioning the anchor again would double-count it.
  const anchorPool = characterAnchorPool(input.characterAnchor);
  const { assets, selections } = mergePool(
    { assets: input.assets ?? [], selections: input.selections ?? [] },
    anchorPool
  );

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
    ...(assets.length ? { assets } : {}),
    ...(selections.length ? { selections } : {}),
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

// Pooled assets/selections persisted by a prior (possibly interrupted) run for
// the same goal. `savePartialProject` rewrites the whole project from the
// in-memory pool, so the route must seed that pool with what's already
// persisted — otherwise keyframes generated before an interruption are dropped
// on resume even though their clips are reused (asset-pool PR D, North Star
// Principle 9 "nothing is throwaway").
export async function resumablePoolForGoal(goal: string): Promise<{
  assets: Asset[];
  selections: AssetSelection[];
}> {
  const existing = await getProject();
  if (existing.goal !== goal || !existing.timeline) {
    return { assets: [], selections: [] };
  }
  return {
    assets: existing.assets ?? [],
    selections: existing.selections ?? [],
  };
}

type SoundtrackRequest = { goal: string; style: string; targetLengthSec: number };

// Tolerance (seconds) for the LEGACY fallback only: a soundtrack from before
// request fingerprints rarely lands exactly on the requested length.
const SOUNDTRACK_DURATION_TOLERANCE_SEC = 1.5;

// Whether a freshly-generated cached soundtrack satisfies the current request:
// its frozen request fingerprint must equal the current one. Pure + exported so
// the match rule is unit-testable without the store. Returns false when the clip
// predates request fingerprints — the caller then applies the legacy fallback.
export function soundtrackMatchesRequest(
  clip: Clip,
  request: SoundtrackRequest
): boolean {
  const stored = clip.generatedBy?.requestFingerprint;
  return stored !== undefined && stored === soundtrackRequestFingerprint(request);
}

// Legacy fallback for soundtracks generated before request fingerprints existed:
// the prior heuristic (style + approximate length; goal checked by the caller).
// Without this, an upgrade would drop an otherwise-usable track — and if
// ELEVENLABS_API_KEY is unset, regeneration returns null and the project saves
// with no audio at all. Style/length content match is pure + exported for tests.
export function legacySoundtrackContentMatches(
  clip: Clip,
  request: Pick<SoundtrackRequest, "style" | "targetLengthSec">
): boolean {
  const duration = clip.measuredDurationSec ?? clip.durationSec;
  const lengthMatches =
    Math.abs(duration - request.targetLengthSec) <=
    SOUNDTRACK_DURATION_TOLERANCE_SEC;
  const styleMatches = clip.generatedBy?.prompt
    ? clip.generatedBy.prompt.includes(`Visual style: ${request.style}`)
    : true;
  return lengthMatches && styleMatches;
}

export async function resumableSoundtrackForGoal(
  input: SoundtrackRequest
): Promise<Clip | null> {
  const existing = await getProject();
  const candidate = existing.clips.find((clip) => clip.kind === "audio");
  if (!candidate) return null;

  // Fresh path: an exact request-fingerprint match (goal included) — replaces
  // the old goal-equality + duration-tolerance + style-substring heuristic.
  if (candidate.generatedBy?.requestFingerprint !== undefined) {
    return soundtrackMatchesRequest(candidate, input) ? candidate : null;
  }

  // Legacy path: a track generated before fingerprints. Reuse it when the goal
  // still matches and style/length are close, rather than dropping a usable clip
  // (especially when regeneration is unavailable). It will pick up a fingerprint
  // the next time it is regenerated.
  return existing.goal === input.goal &&
    legacySoundtrackContentMatches(candidate, input)
    ? candidate
    : null;
}

type ResumableCharacter = {
  profile: CharacterProfile;
  reference: CharacterReference;
  clip: Clip;
  path: string;
  // The pooled `character_anchor` asset backing this character, when resolved
  // via the active selection (asset-pool PR E). Legacy projects without a pooled
  // anchor resume via the reference scan and synthesize one from the profile.
  anchor: Asset;
};

async function localGeneratedFileExists(url: string): Promise<string | null> {
  const filePath = localGeneratedPath(url);
  if (!filePath) return null;
  try {
    await fs.access(filePath);
  } catch {
    return null;
  }
  return filePath;
}

// PREFER the active `character_anchor` selection/asset from the pool (asset-pool
// PR E; the self-describing replacement for the "approved hero_frame" scan). The
// anchor carries `depicts.characterId` + folded characterInvariants; we recover
// the legacy profile/reference/clip the keyframe path still needs from the
// matching characterId/assetId.
export function resumableCharacterFromAnchor(
  existing: Project
): { profile: CharacterProfile; reference: CharacterReference; clip: Clip; anchor: Asset } | null {
  const characterId = existing.characterProfiles?.[0]?.id;
  if (!characterId) return null;
  const anchor = resolveActiveAsset(existing, "character_anchor", characterId);
  if (!anchor || anchor.role !== "character_anchor") return null;
  const profile = existing.characterProfiles?.find(
    (item) => item.id === anchor.depicts?.characterId
  );
  const reference = existing.characterReferences?.find(
    (item) => item.assetId === anchor.id
  );
  const clip = existing.clips.find((item) => item.id === anchor.id);
  if (!profile || !reference || !clip) return null;
  return { profile, reference, clip, anchor };
}

export async function resumableCharacterForGoal(
  goal: string
): Promise<ResumableCharacter | null> {
  const existing = await getProject();
  if (existing.goal !== goal) return null;

  // Preferred path: the pooled active character_anchor selection.
  const fromAnchor = resumableCharacterFromAnchor(existing);
  if (fromAnchor) {
    const filePath = await localGeneratedFileExists(fromAnchor.clip.url);
    if (filePath) return { ...fromAnchor, path: filePath };
  }

  // Legacy fallback: scan persisted character references for an approved
  // hero_frame (projects generated before the character_anchor pool/selection).
  const reference = existing.characterReferences?.find(
    (item) => item.role === "hero_frame" && item.quality === "approved"
  );
  if (!reference) return null;
  const profile = existing.characterProfiles?.find(
    (item) => item.id === reference.characterProfileId
  );
  const clip = existing.clips.find((item) => item.id === reference.assetId);
  if (!profile || !clip) return null;
  const filePath = await localGeneratedFileExists(clip.url);
  if (!filePath) return null;
  return {
    profile,
    reference,
    clip,
    path: filePath,
    anchor: characterAnchorAsset({ profile, clip }),
  };
}
