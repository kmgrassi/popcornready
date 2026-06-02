// Candidate-stale computation (provenance-graph lane, task #6). Pure graph walk:
// for each asset with a frozen fingerprint, recompute its hash from the CURRENT
// plan/pool and compare. The output is a *signal* handed to the orchestrator —
// never an action. Per NORTH_STAR Principle 3 the agent decides what to actually
// regenerate and may prune cascades it judges semantically irrelevant; this
// module deliberately has no generation capability.

import type { Asset } from "@/lib/assets/types";
import type { EditPlan } from "@/lib/types";
import {
  FINGERPRINT_VERSION,
  hashAsset,
  recomputeFingerprints,
  upstreamIdsOf,
} from "./fingerprint";

export interface StaleCandidate {
  assetId: string;
  // input_changed: the asset's OWN plan context drifted (a beat edit, or a
  // style/aspect change — the prompt is rebuilt from the whole arc). upstream_stale:
  // the asset's own inputs are unchanged but an asset it was built from is itself
  // a candidate.
  reason: "input_changed" | "upstream_stale";
  // Which inputs drifted: "plan" for input_changed (the change is in the plan
  // context the prompt is built from — we don't store the prior plan, so we
  // can't pinpoint which beat), plus the asset's beatId when it has one; the
  // upstream asset IDs whose hash changed for upstream_stale.
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
    // A stored hash from a different fingerprint version is not comparable to a
    // freshly-computed one — treat it as having no baseline rather than flagging
    // it stale purely because the hashed shape was bumped.
    if (stored.fingerprintVersion !== FINGERPRINT_VERSION) continue;
    const fresh = recomputed.get(asset.id);
    if (!fresh) continue;
    if (fresh.inputHash === stored.inputHash) continue; // unchanged

    // Recompute using the asset's OWN current content but the STORED upstream
    // hashes. If that already differs from the stored hash, the asset's own plan
    // context drifted (a beat/style/aspect edit); otherwise the only difference
    // is from upstream, so it's upstream_stale.
    const ownHash = hashAsset(asset, plan, stored.upstreamHashes).inputHash;
    if (ownHash !== stored.inputHash) {
      const beatId = asset.provenance?.inputs?.beatId;
      candidates.push({
        assetId: asset.id,
        reason: "input_changed",
        changedInputs: beatId ? ["plan", beatId] : ["plan"],
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
