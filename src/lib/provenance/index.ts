// Provenance graph: stable input edges + content fingerprints + a cheap,
// deterministic candidate-stale set handed to the agent as a *signal*. See
// docs/scopes/north-star-provenance-graph.md and NORTH_STAR Principles 3 & 4.

export {
  FINGERPRINT_VERSION,
  canonicalJSON,
  hashAsset,
  recomputeFingerprints,
  upstreamIdsOf,
} from "./fingerprint";
export { buildProvenanceGraph } from "./graph";
export type { ProvenanceGraph, ProvenanceNode } from "./graph";
export { computeCandidateStaleSet } from "./stale";
export type { StaleCandidate } from "./stale";
export { freezeFingerprints } from "./freeze";
