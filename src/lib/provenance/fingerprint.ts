// Content fingerprints over an asset's semantic inputs (provenance-graph lane,
// docs/scopes/north-star-provenance-graph.md task #4). Pure: no I/O, no
// generation. A fingerprint folds in the hashes of the asset's upstream assets,
// so a change deep in the graph (a regenerated anchor, a new soundtrack) ripples
// upward into a different recomputed hash — the basis for the candidate-stale
// set (see ./stale.ts).
//
// Determinism rule: for a *frozen* generated asset the only semantic input that
// can change after generation is the content of the beat it serves (resolved
// from the mutable plan) and its upstream hashes; prompt/model/providerSettings
// are stored on the asset and never change (regeneration mints a NEW asset).
// That split is what lets the stale walk tell "this beat changed" apart from
// "an upstream asset changed".

import { createHash } from "crypto";
import type { Asset, AssetFingerprint, AssetInputs } from "@/lib/assets/types";
import type { EditPlan } from "@/lib/types";

// Bump when the hashed payload shape below changes, so fingerprints frozen by an
// older build are recognised as a different version rather than silently
// flagging the whole pool stale.
export const FINGERPRINT_VERSION = "fp.v1";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// Deterministic JSON: object keys sorted recursively so key insertion order
// never affects the hash. Arrays keep their order (it is semantic). undefined
// members are dropped (treated as absent).
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    if (obj[key] === undefined) continue;
    out[key] = canonicalize(obj[key]);
  }
  return out;
}

// Every other-asset reference an asset's inputs point at, deduped and sorted.
// beatId is deliberately excluded — a beat is plan content, not an asset, and is
// hashed as content (see beatContent below).
export function upstreamIdsOf(inputs: AssetInputs | undefined): string[] {
  if (!inputs) return [];
  const ids = new Set<string>();
  for (const id of inputs.anchorIds ?? []) ids.add(id);
  for (const id of inputs.referenceAssetIds ?? []) ids.add(id);
  for (const id of inputs.upstreamAssetIds ?? []) ids.add(id);
  if (inputs.firstFrameAssetId) ids.add(inputs.firstFrameAssetId);
  if (inputs.audioId) ids.add(inputs.audioId);
  return [...ids].sort();
}

// The content of the beat an asset serves, resolved from the (mutable) plan.
// Returns null when the asset has no beatId or the beat is gone. Only the
// semantic fields are hashed — `id` is excluded so renaming/reordering beats
// without changing their content does not flag a candidate.
function beatContent(
  inputs: AssetInputs | undefined,
  plan: EditPlan | null
): { name: string; intent: string; durationSec: number } | null {
  if (!inputs?.beatId || !plan) return null;
  const beat = plan.beats.find((b) => b.id === inputs.beatId);
  if (!beat) return null;
  return { name: beat.name, intent: beat.intent, durationSec: beat.durationSec };
}

// The frozen, generation-time part of an asset's identity: what it was made
// from, independent of the mutable plan/pool. Never changes for a frozen asset.
function frozenPayload(asset: Asset): Record<string, unknown> {
  const p = asset.provenance;
  if (!p) {
    // Upload / un-generated leaf: identity is its media, which only changes if
    // the upload itself is replaced (a new asset id).
    return { source: asset.source, kind: asset.kind, mediaUrl: asset.media.url };
  }
  return {
    source: asset.source,
    kind: asset.kind,
    provider: p.provider,
    model: p.model,
    prompt: p.prompt,
    providerPrompt: p.providerPrompt,
    // The character-consistency settings that actually condition the output.
    consistencyMode: p.characterBinding?.consistencyMode,
    providerSettings: p.characterBinding?.providerSettings,
    promptInvariantVersion: p.characterBinding?.promptInvariantVersion,
  };
}

// Hash one asset given the already-computed hashes of its upstream assets.
// Exposed so the stale walk can recompute with *stored* upstream hashes.
export function hashAsset(
  asset: Asset,
  plan: EditPlan | null,
  upstreamHashes: Record<string, string>
): AssetFingerprint {
  const inputHash = sha256(
    canonicalJSON({
      frozen: frozenPayload(asset),
      beat: beatContent(asset.provenance?.inputs, plan),
      upstreamHashes,
    })
  );
  return { fingerprintVersion: FINGERPRINT_VERSION, inputHash, upstreamHashes };
}

// Recompute fingerprints for every asset from the *current* plan/pool, folding
// upstream hashes via a memoised DFS. Cheap: O(graph), hashes input descriptors
// only (never media bytes). A cycle (shouldn't occur) contributes an empty hash
// for the back-edge rather than looping forever.
export function recomputeFingerprints(
  assets: Asset[],
  plan: EditPlan | null
): Map<string, AssetFingerprint> {
  const byId = new Map(assets.map((a) => [a.id, a]));
  const out = new Map<string, AssetFingerprint>();
  const inProgress = new Set<string>();

  const visit = (id: string): string => {
    const cached = out.get(id);
    if (cached) return cached.inputHash;
    const asset = byId.get(id);
    if (!asset) return ""; // dangling reference: contributes nothing
    if (inProgress.has(id)) return ""; // cycle guard
    inProgress.add(id);

    const upstreamHashes: Record<string, string> = {};
    for (const upstreamId of upstreamIdsOf(asset.provenance?.inputs)) {
      const hash = visit(upstreamId);
      if (hash) upstreamHashes[upstreamId] = hash;
    }
    const fingerprint = hashAsset(asset, plan, upstreamHashes);
    inProgress.delete(id);
    out.set(id, fingerprint);
    return fingerprint.inputHash;
  };

  for (const asset of assets) visit(asset.id);
  return out;
}
