// Freeze content fingerprints onto pooled assets at generation/persist time
// (provenance-graph lane, task #4 storage half). Write-ONCE: an asset's
// fingerprint records the plan/upstream state it was generated against, so a
// later beat edit shows up as drift in the candidate-stale walk. Re-freezing an
// already-frozen asset would erase that baseline, so we only fill the gaps.

import type { Asset } from "@/lib/assets/types";
import type { EditPlan } from "@/lib/types";
import { recomputeFingerprints } from "./fingerprint";

export function freezeFingerprints(
  assets: Asset[],
  plan: EditPlan | null
): Asset[] {
  // Nothing to fold a hash over, or every asset is already frozen → no-op.
  if (assets.length === 0) return assets;
  const needsFreeze = assets.some(
    (a) => a.provenance && !a.provenance.fingerprint
  );
  if (!needsFreeze) return assets;

  const fingerprints = recomputeFingerprints(assets, plan);
  return assets.map((asset) => {
    if (!asset.provenance || asset.provenance.fingerprint) return asset;
    const fingerprint = fingerprints.get(asset.id);
    if (!fingerprint) return asset;
    return { ...asset, provenance: { ...asset.provenance, fingerprint } };
  });
}
