# North Star — Provenance Graph

> **Goal (one line):** Give every generated asset a stable ID, an explicit
> record of the semantic inputs (by ID) it was built from, and a content
> **fingerprint**, so a change to any input yields a cheap, deterministic
> **candidate-stale set** that is handed to the agent as a *signal* — never a
> rigid cascade.

## Status & sibling cross-refs

- **Status:** P0 scope (design only). No code. Aligns to
  [`docs/NORTH_STAR.md`](../NORTH_STAR.md) Principles 3 & 4 and §5 (target data
  model, "Invalidation via input fingerprints"), and the §8 resolution
  "Invalidation granularity — DECIDED: per-asset content fingerprints (with
  nested upstream hashes) produce a *candidate* stale set."
- **This is the provenance-graph workstream.** It owns: stable IDs on
  beats/anchors/segments, per-asset input fingerprints, the
  dependency/provenance graph, and candidate-stale computation. It does **not**
  own asset storage shape, the orchestrator, or composition.
- **Sibling workstreams (stay in lane; cross-reference, do not redo):**
  - **asset-pool** — owns the unified, immutable, project-scoped asset shape
    (`projectId`, `kind`, role/what-it-depicts) and the pool itself. We *depend
    on* that shape: provenance + fingerprint fields live **on** the pooled asset
    this workstream describes only the provenance/fingerprint subset, and treats
    the asset's identity/storage as asset-pool's contract.
  - **orchestrator-tools** — the *consumer* of the candidate-stale set. We
    define and emit the set + provenance + IDs; the orchestrator decides what to
    regenerate and proposes a plan (NORTH_STAR Principle 5). We hand it a typed
    query API; it owns the tools and the agent loop.
  - **provenance/composition** — composites (clip → scene → sub-video) are the
    same graph; this workstream defines the *edge* semantics (inputs by ID +
    hashes) that composition reuses for composite nodes.
  - **store-consolidation / unified-engine** — collapse of the two pipelines and
    the dual stores; we note where provenance must be written in *both* paths
    today and where it lands once unified, but do not perform the merge.
  - **inspection-feedback** — surfaces provenance/candidates in the UI; we make
    the data inspectable, they render it.

## North Star alignment

This workstream is the **foundation** for Principle 4 ("A dependency/provenance
graph is the foundation — not the agent's cleverness… Build the graph; the agent
reasons over it. This is no-regret"). Without input edges + fingerprints,
"rethink the audio → minimal redo" (Principle 3) is uncomputable, which is
exactly the gap NORTH_STAR §3 calls out: *"beats have no stable id … generated
assets store the prompt but not the beat/anchor they serve. So 'beat 3 changed →
regenerate clip 3' cannot be computed from data today."*

Per Principle 3 the stale set is a **candidate** signal: determinism scopes the
*possibilities*, the agent decides the *actuals* and may prune cascades it judges
semantically irrelevant. This scope therefore deliberately stops at *computing
and exposing* candidates; it does **not** auto-regenerate.

## Current state (cited)

**Stable IDs — partial.**
- `Beat` has **no `id`** — only `name` / `durationSec` / `intent`
  (`src/lib/types.ts:143-147`). The timeline links a segment to a beat by the
  free-text `role` string only (`TimelineSegment.role`, `src/lib/types.ts:182`),
  and the run builds segments by **positional index** into `plan.beats`
  (`src/lib/runs/execute.ts:456-463`,
  `src/app/api/oneshot/project-cache.ts:33-43`).
- `TimelineSegment` has an `id` (`src/lib/types.ts:178`) and `Clip` has an `id`
  (`src/lib/types.ts:119`), so segments and assets are addressable, but the beat
  is not, so the segment→beat link is by string match
  (`compileEditGraphToTimeline`, `src/lib/edit-graph.ts:440-453`, resolves beats
  by `beatIdsByRole`).
- The edit-graph *synthesizes* a beat id at compile time
  (`editGraphBeatId(index, name)` → `beat_${i+1}_${name}`,
  `src/lib/edit-graph.ts:145-147`), but it is **derived, not stored on the
  plan** — regenerating the plan re-derives ids, so they are not stable across
  edits.
- **Anchors:** the NORTH_STAR "planner-decided anchors" (PR #89) are **not** a
  typed entity in the tree. The only reference-by-id dependency vocabulary is
  `OverlayAnchor` (`src/lib/edit-graph/types.ts:290-295`), which is aspirational
  and unwired. Today "anchor" appears only as prompt language
  (`src/app/api/oneshot/prompts.ts:15`,
  `src/app/api/oneshot/media-generation.ts:232`) and as the character hero-frame
  path (`src/lib/oneshot/character-reference.ts`). `CharacterReference` has an
  `id` (`src/lib/types.ts:42-49`).

**Per-asset provenance — rich on character refs, blind on structural inputs.**
- `Clip.generatedBy { provider, model, prompt, providerPrompt, characterBinding,
  preflight, costUsd }` (`src/lib/types.ts:129-138`) and
  `GeneratedAssetCharacterBinding { referenceIds, consistencyMode, seed,
  promptInvariantVersion, … }` (`src/lib/types.ts:97-116`) record *what
  character refs* an asset used — but **not** the `beatId`, `anchorId(s)`, or
  `audioId` the asset was generated for. In the run, the clip's `generatedBy`
  stores provider/model/prompt only (`src/lib/runs/execute.ts:148-154`); the
  beat it serves is known *at the call site* but **never persisted on the
  asset**.
- The v1 path is marginally richer: `GeneratedAssetProvenance` carries
  `referenceAssetIds` (`src/lib/api/v1/provenance.ts:25-36`,
  `src/lib/api/v1/generated-assets.ts:429-437`) and the asset records
  `generatedAssetJobId` (`src/lib/v1/types.ts:94`) — but still **no beatId** and
  no fingerprint.
- Timeline-level lineage is the strongest record: `TimelineProvenance
  { briefVersionId, compositionId, sourceAssetIds, generatedAssetJobIds,
  criticReport, … }` (`src/lib/v1/types.ts:187-217`) — but it is per-timeline,
  not per-asset, and carries no input hashes.

**Fingerprints / staleness — none, except one ad-hoc string match.**
- There is **no `inputHash`, `fingerprint`, `stale`, or `dirty`** field anywhere
  on an asset or beat (confirmed by tree-wide search). `createHash` is used only
  for idempotency request hashing (`src/lib/v1/generation/create-job.ts:13-38`,
  `src/lib/api/v1/handler.ts:75`) and for the character-prompt invariant version
  (`src/lib/oneshot/character-reference.ts:96-109`,
  `src/lib/generative/character-context.ts:84`) — none of which is an asset
  input fingerprint.
- The closest thing to invalidation today is a hand-rolled, brittle check:
  `resumableSoundtrackForGoal` reuses a cached soundtrack only if the goal is
  unchanged **and** the duration is within 1.5s **and** the prompt string
  contains `Visual style: <style>`
  (`src/app/api/oneshot/project-cache.ts:97-118`). This is exactly the
  string-match staleness the fingerprint model generalizes and replaces.
- Idempotency hashing proves the *pattern* works — `requestBodyHash` canonicalises
  a JSON shape and sha256s it (`create-job.ts:27-38`) — but it hashes the
  *request*, not the *resolved semantic inputs*, and is not stored on the asset.

**Generation is not a graph node; the edit graph is forward-only.**
- `EditGraph.edit.decisions` are only `select_segment`
  (`src/lib/edit-graph.ts:64-77`); generating an asset is a side effect outside
  the graph (`generateBeatClip`, `src/lib/runs/execute.ts:95-155`). The richer
  `src/lib/edit-graph/types.ts` (PR1 vocabulary) has `EditDecision`,
  `TransitionDecision`, `Overlay`, etc. but **no** generation/regeneration node
  and no input-edge concept either.
- `Patch` (`src/lib/types.ts:270-297`) is timeline-forward only
  (replace/trim/remove/reorder/add/caption); there is no `regenerate_asset`,
  `change_beat`, or `swap_anchor`.

**Two pipelines write provenance differently.** The async run
(`src/lib/runs/execute.ts`) and the sync one-shot
(`src/app/api/oneshot/route.ts`) both build segments positionally and persist a
single mutable `Project` with `id: "default"`
(`src/lib/runs/execute.ts:506-528`, `project-cache.ts:53-77`); the v1 stack
(`src/lib/api/v1/store.ts`) persists multi-project assets with
`GeneratedAssetProvenance`. Provenance fields must be added consistently in both
shapes (cross-ref store-consolidation / unified-engine for the eventual merge).

## Gap vs North Star

| North Star wants | Today | Gap |
| --- | --- | --- |
| Stable id on every beat | `Beat` has no id; linked by `role` string | Add `Beat.id`; persist it; key segment→beat by id |
| Stable id on anchors | No anchor entity; only `CharacterReference.id` + unwired `OverlayAnchor` | Define an anchor id (or adopt asset-pool's), reference it from assets |
| Asset records its semantic inputs by id | Only character `referenceIds`; beat/audio known but unpersisted | Add `inputs { beatId, anchorIds[], audioId?, upstreamAssetIds[] }` |
| Content fingerprint w/ nested upstream hashes | None (only request-idempotency + prompt-invariant hashes) | Add `inputFingerprint` over canonicalised semantic inputs + upstream hashes |
| Cheap candidate-stale set on change | One brittle string match for audio | Build a graph walk: changed node → downstream candidates |
| Candidates surfaced to the agent (signal, not cascade) | No surface; agent has no IDs/provenance to reason over | Typed read API returning IDs + provenance + candidates |
| Generation as a first-class node | Side effect outside the graph | Provenance graph node per generated asset (this scope's graph, distinct from edit-graph) |

## Target design (design level — types are illustrative, not final)

The graph is **derived from the assets**, not a separate authored document:
because each asset is self-describing (its `inputs` name upstream IDs), the graph
is just an index built by walking the project's assets. This keeps it in lockstep
with asset-pool's "relationships live on the assets themselves" decision
(NORTH_STAR §5/§8).

### 1. Stable IDs

```ts
interface Beat {
  id: string;            // NEW — stable, minted once, survives replan
  name: string;
  durationSec: number;
  intent: string;
}
```

- Mint `Beat.id` when the plan is first produced; **preserve** ids across replans
  where a beat is recognisably "the same" (match by id when the agent edits a
  beat; mint new ids only for genuinely new beats). This is what makes "beat 3
  changed" addressable rather than positional.
- Segments key to beats by id, not `role`: add `TimelineSegment.beatId`
  (keep `role` as a human label). `compileEditGraphToTimeline`
  (`src/lib/edit-graph.ts:440-453`) resolves by id instead of `beatIdsByRole`.
- **Anchors:** adopt asset-pool's anchor id if/when defined; until then treat the
  existing `CharacterReference.id` as the anchor id and reference it from asset
  inputs. (NORTH_STAR §8 folds character into the anchor model; we align names
  but do not perform that retirement here.)

### 2. Per-asset provenance: semantic inputs by ID

A small, additive block on the generated-asset provenance (lives on the pooled
asset — exact host field owned by asset-pool):

```ts
interface AssetInputs {
  beatId?: string;            // the beat this asset serves
  anchorIds?: string[];       // anchors/character refs it was conditioned on
  audioId?: string;           // soundtrack/voiceover it was aligned to
  upstreamAssetIds?: string[];// e.g. keyframe a clip was seeded from; child IDs of a composite
  // free-text prompt/model/seed already exist in generatedBy / providerSettings
}
```

- Extends, does not replace, today's `Clip.generatedBy`
  (`src/lib/types.ts:129-138`) and `GeneratedAssetProvenance`
  (`src/lib/api/v1/provenance.ts:25-36`). `referenceAssetIds` maps onto
  `anchorIds`.
- Written at the call site that already knows the beat (e.g.
  `src/lib/runs/execute.ts:391-441` where the loop has `beat` in scope;
  `project-cache.ts:33-43`).

### 3. Input fingerprint (with nested upstream hashes)

```ts
interface AssetFingerprint {
  fingerprintVersion: string;   // bump when the hashed shape changes
  inputHash: string;            // sha256 of canonicalised semantic inputs
  upstreamHashes: Record<string, string>; // upstreamAssetId -> its inputHash
}
```

- `inputHash = sha256(canonical({ beat, anchors, audioId, prompt, model, seed,
  providerSettings, upstreamHashes }))`. Reuse the canonical-JSON-then-sha256
  pattern already proven in `requestBodyHash`
  (`src/lib/v1/generation/create-job.ts:27-38`) and the prompt-invariant hash
  (`character-reference.ts:96-109`).
- **Nested**: an asset's hash folds in the `inputHash` of each upstream asset, so
  a change deep in the graph propagates a different hash upward — the basis for
  the candidate set. (This is what `resumableSoundtrackForGoal`'s ad-hoc check,
  `project-cache.ts:97-118`, approximates for one asset; we generalise it.)
- The fingerprint covers **semantic** inputs only. The agent can still judge a
  hash change irrelevant — fingerprint mismatch is *necessary* to flag a
  candidate, not *sufficient* to force regeneration (Principle 3).

### 4. Provenance graph + candidate-stale computation

```ts
interface ProvenanceNode {
  assetId: string;
  kind: string;                 // from asset-pool
  inputs: AssetInputs;
  fingerprint: AssetFingerprint;
}
interface ProvenanceGraph {
  nodes: ProvenanceNode[];
  // edges are implicit: node.inputs.{beatId, anchorIds, audioId, upstreamAssetIds}
}

interface StaleCandidate {
  assetId: string;
  reason: "input_changed" | "upstream_stale";
  changedInputs: string[];      // which input IDs/fields drifted
  storedHash: string;
  recomputedHash: string;
}

// Pure functions (this workstream owns these):
function buildProvenanceGraph(assets, plan): ProvenanceGraph;
function recomputeFingerprints(graph, plan, anchors, audio): Map<assetId, AssetFingerprint>;
function computeCandidateStaleSet(graph, recomputed): StaleCandidate[];
```

- `computeCandidateStaleSet` is a **pure** graph walk: for each node, recompute
  its `inputHash` from current plan/anchors/audio; if it differs from the stored
  hash → `input_changed`; if any upstream node is a candidate → `upstream_stale`.
  Deterministic, cheap, no I/O, no generation.
- Output is the **signal** handed to orchestrator-tools — never an action.

### 5. Read API for the agent (consumed by orchestrator-tools)

```ts
function getProvenance(projectId): ProvenanceGraph;
function getStaleCandidates(projectId): StaleCandidate[];
```

The orchestrator turns candidates + provenance into a proposed re-run plan
(NORTH_STAR Principle 5). We expose; it decides. Generation-as-a-node and the
`regenerate_asset`/`change_beat`/`swap_anchor` vocabulary are **noted as the
consumer's surface** and out of scope here beyond making them computable.

## Work breakdown (ordered, PR-sized)

1. **Stable beat IDs (S).** Add `Beat.id` (`src/lib/types.ts:143`); mint on
   plan creation in both pipelines (`runs/execute.ts`, `oneshot/route.ts`);
   preserve across replans. Add `TimelineSegment.beatId`
   (`src/lib/types.ts:177`); populate at segment build sites
   (`execute.ts:456-463`, `project-cache.ts:33-43`). Thread `beatId` through
   graph synthesis: persist stable beat ids on the plan and have
   `synthesizeEditGraph` set `decision.beatId` from the segment's `beatId`
   instead of the role-string lookup it does today
   (`beatIdsByRole.get(segment.role)`, `edit-graph.ts:308-311,375`) — adding the
   `TimelineSegment.beatId` field alone leaves this path role-string based.
   `compileEditGraphToTimeline` already resolves by id via `beatsById`
   (`edit-graph.ts:437,444`), so no change is needed there once synthesis emits
   real ids. No behaviour change; keep `role` for display. Migration: derive
   `beatId` for existing persisted projects from current `editGraphBeatId`
   logic.

2. **Anchor ID alignment (XS, depends on asset-pool).** Adopt asset-pool's
   anchor id, or treat `CharacterReference.id` as the anchor id; document the
   mapping `referenceAssetIds → anchorIds`. No new entity invented in this lane.

3. **Per-asset semantic inputs (M).** Add `AssetInputs` to the generated-asset
   provenance (host field owned by asset-pool; we define the subset). Populate
   `beatId`/`anchorIds`/`audioId`/`upstreamAssetIds` at every generation call
   site in both pipelines and the v1 generated-assets endpoint
   (`generated-assets.ts:429-437`). Pure additive; backfill best-effort for
   existing assets.

4. **Input fingerprint module (M).** New `src/lib/provenance/fingerprint.ts`:
   canonicalise + sha256 of semantic inputs, fold in `upstreamHashes`. Reuse the
   `requestBodyHash` canonicalisation pattern. Compute + store `AssetFingerprint`
   at generation time. Unit tests: identical inputs → identical hash; any
   semantic input change → different hash; upstream change ripples.

5. **Provenance graph builder (M).** New `src/lib/provenance/graph.ts`:
   `buildProvenanceGraph` (index assets by id, expose implicit edges). Pure,
   tested against fixture projects.

6. **Candidate-stale computation (M).** `computeCandidateStaleSet` graph walk +
   `recomputeFingerprints`. Pure. Tests: change beat 3 → candidate set is its
   keyframe/clip (+ downstream audio/cut if dependent) and **nothing else**;
   prompt-only edit to an unrelated beat → empty/limited set.

7. **Read API + agent surface (S).** `getProvenance` / `getStaleCandidates`
   over the active store. Hand off to orchestrator-tools (cross-ref). Replace the
   ad-hoc `resumableSoundtrackForGoal` string match
   (`project-cache.ts:97-118`) with a fingerprint comparison as the first real
   consumer (proves the model end-to-end on audio).

**Effort:** ~7 PRs; #1, #4, #6 are the load-bearing ones. #2 gated by asset-pool;
#3 touches both pipelines so it is the one to land *after* (or coordinated with)
store-consolidation to avoid double-writing.

## Dependencies & sequencing

- **#1 (beat IDs) first** — everything keys off addressable beats; it is
  independent and no-regret.
- **#2 (anchors)** depends on **asset-pool** defining the canonical anchor/asset
  shape. Until then it is a thin alias (`CharacterReference.id`).
- **#3 (inputs) + #4 (fingerprint)** depend on #1/#2 and on asset-pool's host
  field; ideally land after or alongside **store-consolidation** so provenance is
  written once in a unified engine rather than twice across the drifted
  pipelines (NORTH_STAR §3, §7 P1).
- **#5/#6 (graph + candidates)** depend on #3/#4 (no inputs/hashes → nothing to
  walk).
- **#7 (read API)** is the hand-off to **orchestrator-tools**; the agent surface
  and regeneration vocabulary live there.

## Risks & open questions

- **Beat-identity across replans.** Preserving `Beat.id` when the agent rewrites
  a plan needs a stable matching rule (by id when editing; mint on genuinely new
  beats). Get this wrong and *every* replan looks like a full change → no
  minimal re-run. Open: do we require the planner/agent to echo prior beat ids,
  or diff plans heuristically? (Lean: agent echoes ids; this couples to
  orchestrator-tools.)
- **What is "semantic" in the fingerprint?** Including too much (e.g. raw
  provider prompt with cosmetic whitespace) over-flags; including too little
  under-flags. Needs a canonicalisation policy + `fingerprintVersion` so it can
  evolve without invalidating the whole pool on a code change.
- **Anchor model is unsettled** (NORTH_STAR §8 folds character → anchor; the
  retirement of `generateCharacterHeroFrame` is a separate decision). We must not
  hard-code character-specific assumptions into `anchorIds`.
- **Two pipelines / two stores.** Adding inputs+fingerprints to both the single
  mutable `Project` and the v1 store risks drift; sequencing after
  store-consolidation reduces this but blocks on that workstream. Interim: define
  the fields once in shared types and write them in both.
- **Candidate set must stay a signal.** There is a real temptation to wire
  candidates straight into auto-regeneration; NORTH_STAR Principle 3 forbids it.
  Enforce by giving this workstream **no** generation capability — pure
  computation only; orchestrator-tools owns action.
- **Composite hashing depth.** For deep composites (Principle 8: movie → scenes →
  clips) the nested-hash fold must stay O(graph) and not re-hash media bytes;
  hash *input descriptors*, not files. Coordinate the composite-node edge shape
  with composition.
