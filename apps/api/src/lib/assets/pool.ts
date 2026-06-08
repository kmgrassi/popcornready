// Project-scoped asset pool + active-selection helpers (asset-pool PR C).
//
// The pool is append-only and never deletes (North Star §5, §8). Regeneration
// adds a new Asset and flips a slot's active selection; the prior asset stays
// pooled and reusable in another location. This is introduced ADDITIVELY:
// `Project.clips[]` is still the runtime/render shape, and `poolAssets` presents
// a unified view over both `project.assets` (new self-describing assets) and the
// existing clips. PR F converges `clips[]` into the pool.

import type { Clip, Project } from "@popcorn/shared/types";
import { Asset, clipToAsset } from "@popcorn/shared/assets/types";
import { assertPhotorealFirstFrame } from "../generative/keyframe";

export const DEFAULT_PROJECT_ID = "default";

// Unified view of the project's pool: explicit self-describing assets first,
// then existing clips projected as assets. Deduped by id with the EXPLICIT asset
// winning: once a clip is also pooled as a first-class asset (Clip/Asset
// convergence — generated beat clips become `beat_clip` assets), it lives in
// both `assets[]` and `clips[]` with the same id, and the explicit asset is the
// richer one (role/depicts/provenance.inputs/fingerprint), so the clip
// projection of that id is dropped rather than double-counted.
export function poolAssets(project: Project): Asset[] {
  const projectId = project.id || DEFAULT_PROJECT_ID;
  const explicit = project.assets ?? [];
  const seen = new Set(explicit.map((asset) => asset.id));
  const fromClips = (project.clips ?? [])
    .filter((clip) => !seen.has(clip.id))
    .map((clip) => clipToAsset(clip, { projectId }));
  return [...explicit, ...fromClips];
}

export function findAsset(project: Project, assetId: string): Asset | undefined {
  return poolAssets(project).find((asset) => asset.id === assetId);
}

// The clip backing an asset id, if it lives in `clips[]` (callers that still
// need a runtime Clip / file path).
export function findAssetClip(project: Project, assetId: string): Clip | undefined {
  return (project.clips ?? []).find((clip) => clip.id === assetId);
}

// Append an asset to the pool (idempotent by id; never removes anything).
export function addAsset(project: Project, asset: Asset): Asset {
  project.assets ??= [];
  if (!project.assets.some((existing) => existing.id === asset.id)) {
    project.assets.push(asset);
  }
  return asset;
}

export function getSelection(
  project: Project,
  slotKind: string,
  slotKey: string
): string | undefined {
  return (project.selections ?? []).find(
    (selection) => selection.slotKind === slotKind && selection.slotKey === slotKey
  )?.activeAssetId;
}

// Point a slot at an asset (upsert). The previously-active asset is untouched —
// it remains in the pool, reusable elsewhere.
export function setSelection(
  project: Project,
  slotKind: string,
  slotKey: string,
  activeAssetId: string
): void {
  project.selections ??= [];
  const existing = project.selections.find(
    (selection) => selection.slotKind === slotKind && selection.slotKey === slotKey
  );
  if (existing) existing.activeAssetId = activeAssetId;
  else project.selections.push({ slotKind, slotKey, activeAssetId });
}

export function resolveActiveAsset(
  project: Project,
  slotKind: string,
  slotKey: string
): Asset | undefined {
  const activeAssetId = getSelection(project, slotKind, slotKey);
  return activeAssetId ? findAsset(project, activeAssetId) : undefined;
}

// Resolve the PHOTOREAL first frame for a beat's clip — the single point where a
// clip's image-to-video first frame is chosen. Reads the beat's active
// `beat_keyframe` selection and runs it through the first-frame guardrail
// (Storyboard & Scenes, Part C): a `beat_storyboard` sketch can NEVER be returned
// here. Returns undefined when the beat has no keyframe yet (caller falls back to
// the character/hero frame). Throws `FirstFrameGuardrailError` if the active
// selection is a sketch or otherwise non-photoreal role.
export function resolveBeatFirstFrameAsset(
  project: Project,
  beatId: string
): Asset | undefined {
  const asset = resolveActiveAsset(project, "beat_keyframe", beatId);
  if (!asset) return undefined;
  return assertPhotorealFirstFrame(asset);
}
