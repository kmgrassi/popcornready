// Unified, self-describing, pooled asset — the data-model spine of the North
// Star (docs/NORTH_STAR.md §5, docs/scopes/north-star-asset-pool.md, PR A).
//
// This PR only DEFINES the type and lossless Clip<->Asset adapters; no call
// sites change yet. `Clip` remains the runtime shape until later PRs migrate the
// pool/selection model onto `Asset`. The precise input-edge / fingerprint fields
// on `provenance.inputs` are owned by the provenance-graph lane; this lane just
// declares the slots exist.

import type {
  Clip,
  GeneratedAssetCharacterBinding,
  GenerationPreflightResult,
  VideoSnapshotReview,
} from "../types";

export type AssetKind = "image" | "video" | "audio";

// What slot-class an asset serves. Generalizes CharacterReferenceRole and the
// implicit keyframe/clip/audio distinctions.
export type AssetRole =
  | "character_anchor"
  | "scene_anchor"
  | "beat_keyframe"
  | "beat_clip"
  | "soundtrack"
  | "voiceover"
  | "upload";

// Self-describing "what is this of" — replaces positional/goal-match heuristics.
export interface AssetDepicts {
  characterId?: string;
  beatId?: string;
  subject?: string;
}

// Input edges: which other assets/beats this asset was generated from. Owned and
// extended by the provenance-graph lane; declared here so the asset can carry it.
export interface AssetInputs {
  beatId?: string;
  anchorIds?: string[];
  referenceAssetIds?: string[];
  firstFrameAssetId?: string;
  audioId?: string;
  upstreamAssetIds?: string[];
}

// Content fingerprint over an asset's semantic inputs, with the nested hashes of
// its upstream assets folded in. Frozen at generation time so a later change to
// any input (a beat's intent, a regenerated anchor, …) yields a different
// recomputed hash — the basis for the candidate-stale set. The provenance-graph
// lane owns the computation (src/lib/provenance/); the shape lives here because
// it is hosted on the pooled asset. See docs/scopes/north-star-provenance-graph.md.
export interface AssetFingerprint {
  // Bumped when the hashed shape changes, so old fingerprints don't silently
  // mismatch on a code change (would otherwise flag the whole pool stale).
  fingerprintVersion: string;
  // sha256 of the canonicalised semantic inputs (beat content, prompt, model,
  // and the sorted upstreamHashes below).
  inputHash: string;
  // upstreamAssetId -> that asset's inputHash, folded into inputHash so a change
  // deep in the graph ripples upward.
  upstreamHashes: Record<string, string>;
}

// Provenance block — the existing Clip.generatedBy fields plus input edges.
export interface AssetProvenance {
  provider: string;
  model?: string;
  prompt: string;
  providerPrompt?: string;
  originalPrompt?: string;
  preflight?: GenerationPreflightResult;
  costUsd?: number;
  characterBinding?: GeneratedAssetCharacterBinding;
  inputs?: AssetInputs;
  // Frozen at generation time (provenance-graph lane). Absent on assets minted
  // before fingerprints existed; treated as "no stored hash" by the stale walk.
  fingerprint?: AssetFingerprint;
  // Canonical hash of the stable request inputs this asset was generated for
  // (mirrors Clip.generatedBy.requestFingerprint); drives reuse-vs-regenerate.
  requestFingerprint?: string;
}

export interface CharacterInvariants {
  identity?: string;
  wardrobe?: string;
  negative?: string;
}

export interface Asset {
  id: string;
  schemaVersion?: "asset.v1";
  projectId: string;
  kind: AssetKind;
  role: AssetRole;
  depicts?: AssetDepicts;
  // User/agent-facing description hint (carried over from Clip.description).
  description?: string;
  media: {
    url: string;
    filename: string;
    durationSec: number;
    measuredDurationSec?: number;
  };
  provenance?: AssetProvenance;
  source: "upload" | "generated";
  // Only meaningful for role: "character_anchor" — folds the single-hero
  // CharacterProfile identity model onto the anchor asset.
  characterInvariants?: CharacterInvariants;
  // Top-level character binding, mirroring Clip.characterBinding. Kept distinct
  // from provenance.characterBinding because review metadata
  // (updateGeneratedAssetReview) is written onto the top-level binding and can
  // diverge from the generation-time one — so both must round-trip.
  characterBinding?: GeneratedAssetCharacterBinding;
  videoReview?: VideoSnapshotReview;
}

// An "active pointer" from a location/slot into the pool. Regeneration adds a
// new Asset and flips `activeAssetId`; prior assets stay pooled and reusable.
// `slotKind` examples: "timeline_segment", "character_anchor", "beat_keyframe",
// "beat_clip", "soundtrack". `slotKey` is the location id (a beatId, characterId,
// segment id, or "main").
export interface AssetSelection {
  slotKind: string;
  slotKey: string;
  activeAssetId: string;
}

// Best-effort role when a bare Clip doesn't tell us its slot-class. Callers that
// know better should pass an explicit role.
export function defaultRoleForKind(kind: AssetKind): AssetRole {
  if (kind === "audio") return "soundtrack";
  if (kind === "image") return "scene_anchor";
  return "beat_clip";
}

// Represent an existing Clip as an Asset. Lossless for round-tripping back to a
// Clip (Clip-only fields are preserved); role/projectId/depicts are supplied by
// the caller since a bare Clip doesn't carry them.
export function clipToAsset(
  clip: Clip,
  opts: { projectId: string; role?: AssetRole; depicts?: AssetDepicts }
): Asset {
  const kind: AssetKind = clip.kind ?? "video";
  return {
    id: clip.id,
    schemaVersion: "asset.v1",
    projectId: opts.projectId,
    kind,
    role: opts.role ?? defaultRoleForKind(kind),
    ...(opts.depicts ? { depicts: opts.depicts } : {}),
    ...(clip.description !== undefined ? { description: clip.description } : {}),
    media: {
      url: clip.url,
      filename: clip.filename,
      durationSec: clip.durationSec,
      ...(clip.measuredDurationSec !== undefined
        ? { measuredDurationSec: clip.measuredDurationSec }
        : {}),
    },
    // Clip.generatedBy is a subset of AssetProvenance (no `inputs`).
    ...(clip.generatedBy ? { provenance: { ...clip.generatedBy } } : {}),
    source: clip.source ?? "generated",
    // Preserve the top-level binding independently of provenance.characterBinding.
    ...(clip.characterBinding ? { characterBinding: clip.characterBinding } : {}),
    ...(clip.videoReview ? { videoReview: clip.videoReview } : {}),
  };
}

// Project an Asset back to the runtime Clip shape. Asset-only fields
// (role/projectId/depicts/inputs/characterInvariants) are dropped — Clip cannot
// hold them — so Asset -> Clip -> Asset is lossy on those, while
// Clip -> Asset -> Clip is lossless.
export function assetToClip(asset: Asset): Clip {
  const generatedBy = asset.provenance
    ? {
        provider: asset.provenance.provider,
        ...(asset.provenance.model !== undefined
          ? { model: asset.provenance.model }
          : {}),
        prompt: asset.provenance.prompt,
        ...(asset.provenance.providerPrompt !== undefined
          ? { providerPrompt: asset.provenance.providerPrompt }
          : {}),
        ...(asset.provenance.characterBinding
          ? { characterBinding: asset.provenance.characterBinding }
          : {}),
        ...(asset.provenance.originalPrompt !== undefined
          ? { originalPrompt: asset.provenance.originalPrompt }
          : {}),
        ...(asset.provenance.preflight
          ? { preflight: asset.provenance.preflight }
          : {}),
        ...(asset.provenance.costUsd !== undefined
          ? { costUsd: asset.provenance.costUsd }
          : {}),
        // Restore the recorded input edges Clip.generatedBy supports (the
        // first-frame keyframe). Asset-only edges (anchorIds, audioId, …) have
        // no Clip home, so Asset -> Clip stays lossy on those by design.
        ...(asset.provenance.inputs?.firstFrameAssetId !== undefined
          ? {
              inputs: {
                firstFrameAssetId: asset.provenance.inputs.firstFrameAssetId,
              },
            }
          : {}),
        ...(asset.provenance.requestFingerprint !== undefined
          ? { requestFingerprint: asset.provenance.requestFingerprint }
          : {}),
      }
    : undefined;
  return {
    id: asset.id,
    filename: asset.media.filename,
    url: asset.media.url,
    kind: asset.kind,
    durationSec: asset.media.durationSec,
    ...(asset.media.measuredDurationSec !== undefined
      ? { measuredDurationSec: asset.media.measuredDurationSec }
      : {}),
    description: asset.description ?? "",
    source: asset.source,
    ...(generatedBy ? { generatedBy } : {}),
    // Restore the top-level binding from the dedicated field (preferred), so a
    // binding updated separately from generation (review metadata) round-trips.
    ...(asset.characterBinding || generatedBy?.characterBinding
      ? {
          characterBinding:
            asset.characterBinding ?? generatedBy?.characterBinding,
        }
      : {}),
    ...(asset.videoReview ? { videoReview: asset.videoReview } : {}),
  };
}
