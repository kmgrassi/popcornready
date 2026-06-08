# North Star Initiative — scope index & sequencing

Tracking hub for the work that moves the app toward
[`docs/NORTH_STAR.md`](../NORTH_STAR.md): an **agent-orchestrated,
non-one-directional** generation pipeline (stages are tools the agent calls;
autonomous by default; any stage re-triggerable; changes recompute only the
affected assets via a dependency/provenance graph over a project-scoped pool of
self-describing, never-deleted assets that compose recursively).

This was scoped by seven parallel audits, each a doc-only PR. This page links
them, records the cross-cutting findings, and lays out the build order.

## The seven workstreams

| # | Lane | Scope doc | PR | Role |
|---|------|-----------|----|------|
| 1 | Asset pool & self-describing assets | `docs/scopes/north-star-asset-pool.md` | #92 | Foundation |
| 2 | Provenance + dependency graph | `docs/scopes/north-star-provenance-graph.md` | #94 | Foundation |
| 3 | Recursive composition | `docs/scopes/north-star-composition.md` | #93 | Builds on 1,2 |
| 4 | Store consolidation | `docs/scopes/north-star-store-consolidation.md` | #96 | Foundation |
| 5 | Unified generation engine | `docs/scopes/north-star-unified-engine.md` | #95 | Cross-cutting |
| 6 | Orchestrator + tool contracts | `docs/scopes/north-star-orchestrator-tools.md` | #97 | Builds on 1,2,5 |
| 7 | Inspection, gates & feedback | `docs/scopes/north-star-inspection-feedback.md` | #98 | Builds on 5,1 |

## Adjacent scopes

| Lane | Scope doc | Role |
|------|-----------|------|
| Story development & agent handoff | `docs/scopes/story-development-agent-handoff.md` | Adds the missing treatment/script layer before the existing scene/beat plan, reusing run-stage artifacts and existing project/brief/plan/composition surfaces first. |

## Cross-cutting findings (surfaced by the audit)

These reframed the work and are encouraging — a lot is "connect / delete," not
"build from scratch":

- **Much of the run/gate/inspection machinery is already built but dead-wired.**
  The v1 `generation-runs` stack has stage items, review gates, a pausing
  progress emitter, approve/reject/retry routes, and gate-aware UI — but nothing
  executes it; the live flow still posts to synchronous `/api/oneshot`. (Lane 7.)
- **`src/lib/runs/` (the async `execute.ts` twin) is dead code** — zero callers.
  Deleting it removes most of the "two pipelines" confusion. (Lanes 5, 4 — and
  the first quick win below.)
- **There are ~4 persistence stores, not 2** (legacy `Project`, an agent-api
  store, the v1 dev-db, the runs store), and `/api/v1` is split across two
  incompatible `V1Project`/`V1Asset` shapes. (Lane 4.)
- **There are two `generateBeatClip` copies and a real `1:1` size bug**
  (`videoSizeForAspect("1:1")` → `1280x720` in one path, `1024x1024` in the
  other). (Lane 5; killed by its PR1.)
- **Strong convergence seam:** the v1 `V1Asset` already carries
  `kind`/`projectId`/`provenance` — the project-scoped asset pool (Lane 1)
  builds directly on it rather than inventing a new shape. (Lanes 1, 4.)
- **No stable beat IDs and structure-blind provenance:** beats link to segments
  by a `role` string; `generatedBy`/`characterBinding` record refs but never the
  `beatId`/`anchorIds`/`audioId` an asset serves; no fingerprints, no staleness.
  (Lane 2 — the keystone for selective regeneration.)

## Recommended build order

**Quick wins (no-regret, do first):** ✅ done
- ~~**Delete dead `src/lib/runs/`**~~ (removed).
- ~~**De-duplicate `generateBeatClip`**~~ (one definition). The `1:1` size mapping
  is a known non-square fallback, not yet changed (no square provider size).

**Phase A — Foundation (interlocking; land roughly together):**
- **Lane 2 (provenance-graph)** is the keystone: stable `Beat.id`,
  `TimelineSegment.beatId`, per-asset input edges + fingerprints, candidate-stale
  computation. Lane 1 defers asset field-schema to it. *(#1 ✅ #101; #2 ✅ via
  Lane 1; #3 mostly ✅; #4–#7 in flight #107/#108.)*
- **Lane 1 (asset-pool)** ✅ #102–#105: one immutable, self-describing `Asset`
  (`kind`/`role`/`projectId`/`provenance`/`depicts`) + pool + `{slot → activeAssetId}`
  selections; persist anchors/keyframes (no throwaway); fold character into a
  `character_anchor` (retire single-hero).
- **Lane 4 (store-consolidation)**: collapse to one project-scoped store; it owns
  physical persistence and gates the asset-pool persistence task.

**Phase B — Engine:**
- **Lane 5 (unified-engine)**: one staged engine that a thin sync entry and an
  async run both wrap; the run model is the trunk (autonomous-by-default, optional
  gates). Defers the run-model choice to Lane 4.

**Phase C — Capabilities (on the foundation + engine):**
- **Lane 3 (composition)**: recursive `AtomicAsset | CompositeAsset`; parallel
  sub-video fan-out + stitch; the composition tree *is* the provenance graph.
- **Lane 6 (orchestrator-tools)**: each step a validated tool (precondition →
  structured failure → self-heal), the orchestrator loop, a regeneration
  vocabulary (`regenerate_asset`/`change_beat`/`swap_anchor`), crude cost
  guardrails. Needs stable beat IDs (Lane 2) and the engine (Lane 5).
- **Lane 7 (inspection-feedback)**: wire up the existing v1 gate/progress
  machinery on the unified run; surface per-asset artifacts live; dashboard
  pool-browse + set-active; close the OODA feedback loop. Mostly connecting
  existing pieces.

## Dependency sketch

```
delete dead runs/ ─┐
1:1 fix + dedupe ──┤ (quick wins)
                   │
provenance-graph(2)─┬─> asset-pool(1) ──┐
store-consolidation(4)──────────────────┤
                                         ├─> unified-engine(5) ─┬─> orchestrator-tools(6)
                                         │                      ├─> inspection-feedback(7)
                              composition(3) ───────────────────┘
```

## Status

All seven scope docs landed as doc-only PRs (#92–#98). Implementation is now
underway; this log tracks merged + in-flight work (newest first).

**Merged to `main`:**
- **Quick wins** — dead `src/lib/runs/` deleted; `generateBeatClip` de-duplicated
  to one definition (`oneshot/media-generation.ts`). *(The `1:1`→`1280x720`
  mapping in `videoSizeForAspect` remains a known non-square fallback, since the
  video providers expose no square size; revisit with provider integrations.)*
- **Lane 2 #1 — stable beat IDs** (#101). `Beat.id` + `TimelineSegment.beatId`
  minted on plan creation and threaded through graph synthesis.
- **Lane 1 — asset pool (FULL lane)** (#102–#105): unified self-describing
  `Asset` + `Clip<->Asset` adapters (lossless only `Clip -> Asset -> Clip`;
  `assetToClip` drops Asset-only fields — `role`/`projectId`/`depicts`/`inputs`/
  `characterInvariants` — so the convergence work must not round-trip pooled
  assets through `Clip`); project-scoped pool +
  `AssetSelection` active-pointers; `projectId` threaded into generation; per-beat
  keyframes persisted as first-class pooled assets; character folded into a
  `character_anchor` asset + selection. This also satisfied Lane 2 #2 (anchor-id
  alignment) and most of Lane 2 #3 (per-asset input edges: `beatId`, `anchorIds`,
  `firstFrameAssetId` are populated on the one-shot path).

- **Lane 2 #4–#7 — provenance fingerprints + graph + candidate-stale** (#107 pure
  core; #108 freeze-at-persist + read API; #110 soundtrack request-fingerprint
  consumer; #111 recovery onto `main`). The keystone for selective regeneration:
  `recomputeFingerprints` / `buildProvenanceGraph` / `computeCandidateStaleSet`,
  frozen onto assets at `saveProject` and exposed via `getProvenanceGraph` /
  `getStaleCandidates`. **Lane 2 fully landed.**

- **Clip/Asset convergence — first slice of Lane 4** ✅ (#112 scope; #113 PR-1
  `poolAssets` dedup; #114 PR-2 pool beat clips as `beat_clip` assets + resume
  backfill; PR-3 `poolResumedBeatClips` tested unit). Generated beat clips are now
  first-class pooled assets, so they carry fingerprints and the keyframe→clip
  stale ripple fires; resumed clips keep their baselines. `clips[]` and all its
  readers (render/editor/resume/export) are unchanged. See
  [`north-star-clip-asset-convergence.md`](./north-star-clip-asset-convergence.md).
  Deferred to the full lane: removing `clips[]`, the six-store merge, the
  `V1Project`/`V1Asset` reconciliation, and pooling the soundtrack/character clip.

**Next up (unstarted):**
- Full Lane 4 (store-consolidation) — collapse the six drifted stores to one
  project-scoped store; reconcile the two `V1Project`/`V1Asset` shapes; migrate
  one-shot + studio off the legacy `Project` doc.
- Lane 5 (unified-engine), then Lanes 3/6/7 on the foundation + engine.

Update this log as PRs merge.
