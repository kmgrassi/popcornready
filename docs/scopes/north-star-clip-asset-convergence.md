# North Star — Clip/Asset Convergence (the first slice of store-consolidation)

> **Goal (one line):** Make generated **beat video clips first-class pooled
> `Asset`s** so they carry provenance fingerprints and appear in the
> candidate-stale set — closing the keyframe→clip ripple gap the provenance PRs
> (#108/#110) explicitly deferred — **without** removing `clips[]` or migrating
> the render/editor paths (that is the full store-consolidation lane).

## Status & relationship to the other lanes

- **Status:** design / scoping only. No code.
- This is the **narrow first slice** of
  [`north-star-store-consolidation.md`](./north-star-store-consolidation.md)
  (Lane 4) — specifically the "PR-F migrate the studio editor / converge
  `Clip`/`Asset`" idea, reduced to the one high-leverage step that unblocks
  provenance. It deliberately **defers** the six-store merge, the two
  `V1Project`/`V1Asset` reconciliation, and the job/artifact-store folding to the
  full lane.
- **Consumes** the landed foundation: the unified `Asset` + `clipToAsset`/
  `assetToClip` adapters (asset-pool, #102–#105) and the fingerprint/graph/stale
  machinery (provenance-graph, #107/#108/#110). It adds **no new asset fields** —
  everything needed already exists on `Asset`/`AssetProvenance`.

## Why now (the concrete gap)

The provenance read API already builds over the unified pool, but generated beat
clips are invisible to staleness:

- `saveProject` freezes fingerprints **only on `p.assets`**, not `p.clips`
  (`src/lib/store.ts:106-108`, `if (p.assets && p.assets.length) p.assets =
  freezeFingerprints(p.assets, p.plan)`).
- Generated beat clips are pushed to `clips[]` and **never added to `assets[]`**.
  In the one-shot loop the clip is created and `clips.push(generatedClip)`
  (`src/app/api/oneshot/route.ts` beat loop; `recordFirstFrameEdge` only writes
  `generatedBy.inputs.firstFrameAssetId` onto the clip). Only **keyframes**
  (`generateBeatKeyframe` → `addAsset`) and the **character anchor**
  (`characterAnchorPool`) become pooled assets; the clips do not.
- A stale candidate requires a stored baseline: `computeCandidateStaleSet` skips
  any asset without `provenance.fingerprint` (`src/lib/provenance/stale.ts:41`)
  and any version mismatch (`:46`).
- The read API projects clips into the graph via `poolAssets` so clip **nodes +
  edges** are visible (`src/lib/store.ts:127-133`, `poolAssets(p)`), but those
  projected clip-assets have **no fingerprint** → they never appear as
  *candidates*. This is exactly the caveat noted in the #108 review reply.

**Net effect today:** edit a beat → its keyframe is flagged `input_changed`, but
the generated clip that keyframe seeded is **not** flagged (no baseline), so the
single most important ripple — "the keyframe changed, therefore re-examine the
clip built from it" — never reaches the agent.

## Grounded current state

- **Adapters (the seam) — already sufficient.** `clipToAsset` carries
  `generatedBy` (incl. `inputs.firstFrameAssetId`), `characterBinding`,
  `videoReview`; `assetToClip` round-trips them. `Clip -> Asset -> Clip` is
  lossless; `Asset -> Clip` drops asset-only fields (`role`/`projectId`/`depicts`/
  the non-`firstFrameAssetId` `inputs`) by design (`src/lib/assets/types.ts`
  `clipToAsset`/`assetToClip`).
- **`poolAssets` has a latent double-count.** It returns
  `[...project.assets, ...project.clips.map(clipToAsset)]`
  (`src/lib/assets/pool.ts:17-24`) with **no dedup by id**. The moment a clip is
  also added to `assets[]` (this change), it would appear twice in the unified
  pool. This must be fixed as part of the slice.
- **Many consumers hard-require `clips[]`** and are explicitly **out of scope**
  here (they keep reading `clips[]` unchanged):
  - Renderer resolves `segment.clipId` against a `clips: Clip[]` map
    (`src/remotion/VideoComposition.tsx:48,67`).
  - `sanitizeTimeline` clamps segments against clip durations
    (`src/lib/timeline.ts:21,37`).
  - Edit-graph synthesis/patch look clips up by id
    (`src/lib/edit-graph.ts:335-365,537-564`).
  - Resume helpers scan `clips[]` (`src/app/api/oneshot/project-cache.ts:159-165`
    `resumableClipsForGoal`, `:203` soundtrack).
  - Studio editor + `/api/project`, `/api/generate-assets`, `/api/export`,
    `/api/compositions`, character-context all read `clips[]`.
- **The keyframe pooling pattern to mirror:** `generateBeatKeyframe` builds an
  `Asset` with `role: "beat_keyframe"`, `depicts.beatId`, and
  `provenance.inputs { beatId, anchorIds }`
  (`src/app/api/oneshot/media-generation.ts` keyframe asset block), added via
  `addAsset` to the in-memory `poolProject`, then persisted through `mergePool`.
  Clips will mirror this with `role: "beat_clip"`.

## Target design

**Keep `clips[]` as the render/editor runtime shape. Additionally pool each
generated beat clip as a `beat_clip` `Asset`** (same `id` as the clip) so it gets
a frozen fingerprint and becomes a graph/stale node. The adapters remain the
seam; nothing that reads `clips[]` changes.

Why pool clips as *rich* `beat_clip` assets (with their own `beatId`) rather than
relying on the existing `clipToAsset` projection: a projected clip-asset only
carries `inputs.firstFrameAssetId` (the one edge `Clip` stores), so it could only
ever be flagged `upstream_stale` *via its keyframe*. But keyframe generation can
fall back/skip (`generateBeatKeyframe` returns `null` → clip seeded from the hero
frame, no first-frame edge), leaving those clips with **no** upstream and **no**
beat — permanently unflaggable. Giving the pooled `beat_clip` asset its own
`depicts.beatId` + `provenance.inputs.beatId` makes a beat edit flag the clip
directly, regardless of whether a keyframe exists.

Same-id twinning is deliberate: `segment.clipId` already equals the clip id, so
the pooled asset is addressable by the same id the timeline and selections use —
and `poolAssets` dedup (below) collapses the twin to the richer explicit asset.

### Status: ✅ landed (#113 PR-1, #114 PR-2, PR-3 in flight)

This slice is implemented. `poolAssets` dedups (#113); generated beat clips are
pooled as `beat_clip` assets with their own `beatId` (#114, `beatClipAsset` /
`poolBeatClip`); resumed clips are backfilled (#114 review fix) and that path is
now a tested unit (`poolResumedBeatClips`, PR-3). The full six-store merge and the
remaining "deferred" items below are unchanged and belong to the full lane.

### Work breakdown (PR-sized, sequenced)

1. **PR-1 — `poolAssets` dedup (no behavior change today).** ✅ #113. Make `poolAssets`
   dedup by id, with **explicit `assets[]` winning** over a `clipToAsset`
   projection of the same id (`src/lib/assets/pool.ts:17-24`). Today no id
   overlaps, so this is a pure correctness/no-regret fix that prevents the
   double-count PR-2 would otherwise introduce. *Effort: S.* Unit test: a clip
   whose id is also an explicit asset yields one (explicit) entry.

2. **PR-2 — Pool generated beat clips as `beat_clip` assets.** ✅ #114
   (`beatClipAsset` / `poolBeatClip`; selection slot `beat_clip` keyed by `beatId`).
   In the one-shot
   beat loop, after a clip is generated (and after `recordFirstFrameEdge`), build
   a `beat_clip` `Asset` from it (same id) with `depicts.beatId` and
   `provenance.inputs { beatId, anchorIds?, firstFrameAssetId? }`, and `addAsset`
   it to `poolProject` — mirroring the keyframe path. Also set a
   `timeline_segment`/`beat_clip` selection keyed by `beatId → clip.id` so the
   active clip per beat is addressable (sets up regeneration later). The clip
   still goes into `clips[]` unchanged. `saveProject`'s existing
   `freezeFingerprints` then stamps the clip asset; `getStaleCandidates` now flags
   clips and the **keyframe→clip ripple fires**. *Effort: M.* Tests: (a) a pooled
   `beat_clip` asset is recorded with the right inputs; (b) integration — freeze a
   keyframe+clip, edit the beat, assert both are candidates; (c) edit a beat whose
   keyframe was skipped, assert the clip is still flagged via its own `beatId`.

3. **PR-3 — Resume pools the clip pool.** ✅ this PR. The #114 review fix already
   backfills resumed clips; PR-3 extracts that into a tested unit
   `poolResumedBeatClips` (in `project-cache.ts`) and locks the guarantees with
   tests: resumed clips are pooled with positional `beat_clip` selections; a prior
   run's frozen baseline is preserved (no double-freeze, no duplicate twin — via
   `addAsset` idempotency); and a legacy resumed clip with no prior asset is pooled
   and flagged by `getStaleCandidates` after a beat edit. `resumablePoolForGoal`
   already carries the persisted `beat_clip` assets, so their fingerprints survive
   resume just like keyframes.

### Explicitly deferred (full store-consolidation lane)

- Removing `clips[]` / making the pool the sole source of truth for render.
- Migrating the renderer, `sanitizeTimeline`, edit-graph, editor, export, and
  resume helpers off `clips[]`.
- Reconciling the two `V1Project`/`V1Asset` stores and folding the job/artifact
  stores (Stores 2–6 in the store-consolidation scope).
- A `fingerprint` host **on `Clip`** — unnecessary; the fingerprint lives on the
  pooled `beat_clip` asset twin.
- Pooling the **character reference clip** and the **soundtrack** as assets.
  (The anchor is already pooled; soundtrack reuse is handled by its
  `requestFingerprint`. Worth a follow-up but not required for the ripple.)

## Risks & open questions

1. **Double-count regression.** PR-2 introduces the clip-in-both-collections
   state, so PR-1's `poolAssets` dedup is a hard prerequisite — land it first (or
   together) and assert it. *Mitigation: dedup test + explicit-wins ordering.*
2. **Selection slot naming.** The keyframe lane uses `beat_keyframe`/`beatId`
   selections; clips need a parallel `slotKind` (`timeline_segment` or
   `beat_clip`) keyed by `beatId`. Pick one and document it so the future
   regeneration vocabulary (`swap`/`regenerate`) targets a stable slot. *Open:
   key by `beatId` (preferred — stable) vs `segmentId` (changes on recompile).*
3. **Over-flagging breadth.** Because beat prompts thread the full arc, a beat
   edit already flags all beat *keyframes*; pooling clips means it now also flags
   all beat *clips*. This is correct (their prompts did change) and the agent
   prunes (Principle 3), but it should be called out so the candidate set isn't
   read as "minimal".
4. **Asset → Clip lossiness if anything later derives `clips[]` from the pool.**
   Not in this slice (we keep writing `clips[]` directly), but flagged for the
   full lane: `assetToClip` drops asset-only `inputs` beyond `firstFrameAssetId`.
5. **Character clip / soundtrack still unpooled.** The graph will show beat clips
   but not the hero reference clip or soundtrack as fingerprinted nodes. Acceptable
   for the ripple goal; noted as deferred so it isn't mistaken for done.

## Definition of done (this slice)

- Generated beat clips appear in `getStaleCandidates` after a beat edit (directly
  via their `beatId`, and the keyframe→clip ripple is observable).
- `poolAssets` returns no duplicate ids when a clip is also an explicit asset.
- `clips[]` and every current `clips[]` reader (render, editor, resume, export)
  are byte-for-byte unchanged; full suite green.
