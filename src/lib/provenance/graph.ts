// Provenance graph (provenance-graph lane, task #5). The graph is *derived* from
// the assets, not a separately authored document: because each asset is
// self-describing (its `provenance.inputs` name upstream IDs), the graph is just
// an index built by walking the pool. Pure, no I/O.

import type { Asset, AssetInputs } from "@/lib/assets/types";
import { upstreamIdsOf } from "./fingerprint";

export interface ProvenanceNode {
  assetId: string;
  kind: Asset["kind"];
  role: Asset["role"];
  inputs: AssetInputs;
  // Resolved upstream asset IDs that exist in the pool (dangling refs dropped).
  upstreamAssetIds: string[];
}

export interface ProvenanceGraph {
  nodes: ProvenanceNode[];
  // Convenience indexes for the read API / orchestrator.
  byId: Map<string, ProvenanceNode>;
  // assetId -> direct dependents (assets that name it as an upstream input).
  dependentsOf: Map<string, string[]>;
}

export function buildProvenanceGraph(assets: Asset[]): ProvenanceGraph {
  const present = new Set(assets.map((a) => a.id));
  const nodes: ProvenanceNode[] = assets.map((asset) => ({
    assetId: asset.id,
    kind: asset.kind,
    role: asset.role,
    inputs: asset.provenance?.inputs ?? {},
    upstreamAssetIds: upstreamIdsOf(asset.provenance?.inputs).filter((id) =>
      present.has(id)
    ),
  }));

  const byId = new Map(nodes.map((n) => [n.assetId, n]));
  const dependentsOf = new Map<string, string[]>();
  for (const node of nodes) {
    for (const upstreamId of node.upstreamAssetIds) {
      const list = dependentsOf.get(upstreamId) ?? [];
      list.push(node.assetId);
      dependentsOf.set(upstreamId, list);
    }
  }
  return { nodes, byId, dependentsOf };
}
