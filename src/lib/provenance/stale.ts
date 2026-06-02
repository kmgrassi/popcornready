// Candidate-stale computation (provenance-graph lane, task #6). Pure graph walk:
// for each asset with a frozen fingerprint, recompute its hash from the CURRENT
// plan/pool and compare. The output is a *signal* handed to the orchestrator —
// never an action. Per NORTH_STAR Principle 3 the agent decides what to actually
// regenerate and may prune cascades it judges semantically irrelevant; this
// module deliberately has no generation capability.

import type { Asset } from "@/lib/assets/types";
import type { EditPlan } from "@/lib/types";
import { hashAsset, recomputeFingerprints, upstreamIdsOf } from "./fingerprint";

export interface StaleCandidate {
  assetId: string;
  // input_changed: the asset's OWN inputs drifted (in practice the beat it
  // serves was edited). upstream_stale: the asset's own inputs are unchanged but
  // an asset it was built from is itself a candidate.
  reason: "input_changed" | "upstream_stale";
  // Which input IDs drifted: the beatId for input_changed, the upstream asset
  // IDs whose hash changed for upstream_stale.
  changedInputs: string[];
  storedHash: string;
  recomputedHash: string;
}

export function computeCandidateStaleSet(
  assets: Asset[],
  plan: EditPlan | null
): StaleCandidate[] {
  const recomputed = recomputeFingerprints(assets, plan);
  const candidates: StaleCandidate[] = [];

  for (const asset of assets) {
    const stored = asset.provenance?.fingerprint;
    if (!stored) continue; // minted before fingerprints existed → no baseline
    const fresh = recomputed.get(asset.id);
    if (!fresh) continue;
    if (fresh.inputHash === stored.inputHash) continue; // unchanged

    // Recompute using the asset's OWN current content but the STORED upstream
    // hashes. If that already differs from the stored hash, the asset's own
    // inputs drifted (the beat changed); otherwise the only difference is from
    // upstream, so it's upstream_stale.
    const ownHash = hashAsset(asset, plan, stored.upstreamHashes).inputHash;
    if (ownHash !== stored.inputHash) {
      candidates.push({
        assetId: asset.id,
        reason: "input_changed",
        changedInputs: asset.provenance?.inputs?.beatId
          ? [asset.provenance.inputs.beatId]
          : ["self"],
        storedHash: stored.inputHash,
        recomputedHash: fresh.inputHash,
      });
    } else {
      const drifted = upstreamIdsOf(asset.provenance?.inputs).filter(
        (id) => (stored.upstreamHashes[id] ?? "") !== (fresh.upstreamHashes[id] ?? "")
      );
      candidates.push({
        assetId: asset.id,
        reason: "upstream_stale",
        changedInputs: drifted,
        storedHash: stored.inputHash,
        recomputedHash: fresh.inputHash,
      });
    }
  }
  return candidates;
}
