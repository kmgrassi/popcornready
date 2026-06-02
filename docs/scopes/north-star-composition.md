# North Star — Composition (recursive atomic/composite assets + parallel generate & stitch)

> **Goal (one line):** Generalize the single hard-coded `Timeline` into a
> uniform, recursive **composite-asset** model (a composite = ordered child
> asset IDs) so the agent can decompose a long video into independently and
> **parallel-generated sub-videos that stitch**, reuse composites by reference,
> and have the composition tree *be* the provenance/dependency graph.

## Status & sibling cross-references

- **Status:** P0 scoping. No code. Authoritative vision is
  `docs/NORTH_STAR.md` — Principle 8 (`docs/NORTH_STAR.md:65-78`) and the
  atomic/composite §5 bullet (`docs/NORTH_STAR.md:166-171`).
- **This lane (composition)** owns: the recursive composite-asset *shape*, the
  decomposition strategy (long video → parallel sub-videos), stitching, and
  composite reuse-by-reference. It deliberately does **not** define the asset
  storage pool, the run engine, or the orchestrator loop — those are siblings.
- **Sibling lanes (stay in lane; cross-reference, do not redo):**
  - **(1) asset-pool** — owns the flat, immutable, `projectId`-scoped pool and
    self-describing asset records. *We assume composites are pool members and
    children are pool IDs; we do not define pool storage.*
  - **(2) provenance-graph** — owns dependency edges, fingerprints, staleness.
    *Per Principle 8 the composition tree and the dependency graph are the same
    graph: a composite's child IDs ARE its provenance edges. We define the
    "child-of" / "stitched-from" edge; they define invalidation over it.*
  - **(3) composition** — **this doc.**
  - **(4) store-consolidation** — collapses the two stores into one project
    pool. *We rely on a single addressable space of asset IDs.*
  - **(5) unified-engine** — the one run that executes generation. *We define
    the parallel fan-out / stitch *unit of work*; the engine schedules/runs it.*
  - **(6) orchestrator-tools** — the agent + its tool surface. *The agent
    **decides** decomposition (when/how to split). We give it a `compose` /
    `decompose` / `stitch` tool contract; it drives the fan-out.*
  - **(7) inspection-feedback** — surfaces artifacts as they pop. *A composite
    is itself an inspectable artifact at every level of the tree.*

## North Star alignment

Principle 8 is the whole of this lane: *"An asset is either atomic (a generated
clip/image/audio) or composite (an ordered selection of other assets, referenced
by ID). Composition is recursive and uniform — clip → scene → sub-video → movie
are the same composite-asset concept at different levels."* (`docs/NORTH_STAR.md:65-78`).

Three load-bearing consequences the design must honor:

1. **Decomposed, not brute-forced.** A 90-min movie = nine 10-min sub-videos
   (each scenes, each clips), generated **in parallel** and stitched
   (`docs/NORTH_STAR.md:71-73`). Today's long video would be one flat beat loop.
2. **Reuse by reference.** A repeated scene is **one composite referenced many
   times**, not regenerated (`docs/NORTH_STAR.md:73-74`).
3. **The agent owns decomposition.** Deciding when/how to split is a
   higher-order strategy call the **agent** makes — not a user instruction and
   not a deterministic rule (`docs/NORTH_STAR.md:74-78`). Our model must make
   decomposition *expressible*, never *automatic*.

Also: §5 "Atomic vs composite assets (recursive)" (`docs/NORTH_STAR.md:166-171`)
— "The same shape models a clip, a scene, a sub-video, and a whole movie;
composites can contain composites… The composition tree and the
provenance/dependency graph are the same graph."

## Current state (cited)

**The timeline is the only composite, and it is a single, flat, non-recursive
level.**

- `Timeline = { aspectRatio, fps, segments: TimelineSegment[], showCaptions? }`
  and `TimelineSegment = { id, clipId, sourceInSec, sourceOutSec, role, reason,
  caption? }` (`src/lib/types.ts:177-193`). A timeline is literally an ordered
  list of segments, each pointing at one `clipId`. This *is* a "composite =
  ordered child asset IDs" — but it is the **only** one, it is **one level deep**
  (segment → clip, never segment → another timeline), and its shape is bespoke
  (`clipId` + trim, not a uniform child reference).
- A `Clip` is the atomic asset (`src/lib/types.ts:118-141`): `kind:
  video|image|audio`, `durationSec`, `generatedBy { provider, model, prompt,
  … }`. There is no `kind: "composite"` and no field by which a clip could
  reference other clips.
- `Project` holds exactly one `timeline: Timeline | null`, one `plan`, one
  `clips: Clip[]` pool (`src/lib/types.ts:375-392`). One project ⇒ one flat cut.

**Generation is a single flat beat loop — no recursion, no parallelism.**

- One-shot: a single `for` loop over `plan.beats`, **sequential**, one clip per
  beat (`src/app/api/oneshot/route.ts:286-395`), then segments built `plan.beats.map`
  one-to-one (`src/app/api/oneshot/route.ts:419-426`). The only parallelism is the
  soundtrack promise running alongside the loop (`src/app/api/oneshot/route.ts:260-270`).
- Async run twin: the same single sequential `for (const beat of plan.beats)`
  loop (`src/lib/runs/execute.ts:391-441`), then `plan.beats.map` to segments
  (`src/lib/runs/execute.ts:456-463`). Two drifted copies of one flat pipeline.
- A long video would simply be a `plan` with more beats → a longer flat loop and
  a longer flat `segments[]`. There is no notion of "this is a scene made of
  sub-clips" or "this is a sub-video made of scenes."

**Stitching is implicit, single-level, and render-time only.**

- The renderer lays segments end-to-end as sibling Remotion `<Sequence>`s in one
  pass: `timeline.segments.map(... <Sequence from=… durationInFrames=…>)`
  (`src/remotion/VideoComposition.tsx:66-123`). There is no data-model concept of
  "stitch these N composites into one"; concatenation only emerges from one flat
  segment list at render. There is no intermediate "rendered sub-video as a new
  asset that a higher composite consumes."

**The rich `aiVideoProject.v1` model is multi-track but still single-level and
unused.**

- `EditGraphTimeline { tracks: EditGraphTrack[] }`, `EditGraphTrack { items:
  TimelineItem[] }`, `TimelineItem.source = { kind: "media"; assetId } | …`
  (`src/lib/edit-graph/types.ts:339-384`). This adds *layering* (tracks/overlays)
  and `OverlayAnchor { type: beat|object|person|spoken_phrase|timeline_time }`
  (`src/lib/edit-graph/types.ts:290-295`) — a typed reference-by-id vocabulary.
- But a `TimelineItem.source` of `kind: "media"` references an `assetId` that is
  an atomic `MediaAsset` (`src/lib/edit-graph/types.ts:30-37`) — there is **no**
  `kind: "composite"` / `kind: "timeline"` source. `AIVideoProject` still holds a
  single `timeline: EditGraphTimeline` (`src/lib/edit-graph/types.ts:487-497`).
  So even the rich model is **one composite, one level**; recursion is absent.
  **Assessment (see Target):** its track/overlay layering and `OverlayAnchor`
  reference-by-id idea are reusable *within an atomic timeline-composite*, but it
  does **not** give us recursion or parallel sub-videos; we add a thin recursive
  composite layer *above* it rather than adopting it wholesale.

**v1 / Composition (existing, but not recursive composition).**

- `CompositionPlan` (`src/lib/types.ts:339-373`, `src/lib/v1/types.ts:99-137`) is
  a per-beat *asset-selection plan* (`plannedBeats[].assetStrategy`,
  `requiredAssetIds`, `generatedAssetJobIds`), **not** a composite of composites.
  `VersionedTimeline` (`src/lib/v1/types.ts:203-217`) carries `provenance {
  sourceAssetIds, generatedAssetJobIds, compositionId }` — lineage, still flat
  `segments: TimelineSegment[]`.
- The edit-graph compiler `compileTimelineViaEditGraph` / `synthesizeEditGraph`
  (`src/lib/edit-graph.ts:300,433,470`) compiles a *single* graph to a *single*
  `Timeline`. No multi-composite compile/stitch.

## Gap vs North Star

| North Star (Principle 8 / §5) | Today |
| --- | --- |
| Uniform `atomic | composite` asset kind, recursive | `Clip` is always atomic; `Timeline` is the one bespoke composite, one level (`src/lib/types.ts:118-193`) |
| Composite = **ordered child asset IDs** (any kind, incl. composites) | `TimelineSegment.clipId` references only atomic clips (`src/lib/types.ts:177-185`) |
| Composition tree **is** the dependency graph | Tree is one level; no `child-of` edge a graph could traverse (sibling lane 2 has nothing recursive to walk) |
| Long video = **parallel** sub-videos, stitched | One **sequential** beat loop (`oneshot/route.ts:286-395`, `runs/execute.ts:391-441`) |
| Repeated scene = **one composite referenced many times** | No referenceable sub-composite; a repeat would be regenerated beats |
| **Agent decides** decomposition | No decomposition concept exists at all |
| Stitch as a first-class, multi-level operation | Stitch is implicit single-level render concat (`VideoComposition.tsx:66-123`) |

## Target design (design-level types/interfaces — illustrative, not final schema)

The core move: **one recursive asset shape** where a composite's body is an
ordered list of child references (each pointing at a pool asset ID), and the
existing `Timeline` becomes *one kind* of composite.

```ts
// A node in the pool is atomic OR composite. (Storage/pool ownership = lane 1.)
type AssetNode = AtomicAsset | CompositeAsset;

type AtomicAsset = {
  id: string;
  projectId: string;          // lane 1
  kind: "video" | "image" | "audio";   // today's Clip
  composite: false;
  url: string;
  durationSec: number;
  generatedBy?: { provider; model?; prompt; … };  // today's Clip.generatedBy
};

// A composite is purely an ordered selection of children, referenced BY ID.
// The SAME shape is a scene, a sub-video, and a whole movie.
type CompositeAsset = {
  id: string;
  projectId: string;
  composite: true;
  compositeKind: "timeline" | "scene" | "sub_video" | "movie" | "track_group";
  children: CompositeChild[];   // ordered; this ordering IS the cut
  // Materialized stitch output (the rendered asset), once produced. Itself an
  // atomic asset ID in the pool — so a parent composite can consume it.
  stitchedAssetId?: string;
  // What it serves (self-describing; lane 1 cares, lane 2 builds edges from it).
  role?: string;               // e.g. beat name, scene label
};

type CompositeChild = {
  // Stable per-child id. MUST round-trip today's TimelineSegment.id: Remotion
  // keys its <Sequence> by it (src/remotion/VideoComposition.tsx:81) and the
  // edit graph references segments by it (VisualEntity/AudioEvent.segmentId,
  // src/lib/edit-graph/types.ts:425,435; patch lookups in
  // src/lib/edit-graph/schemas.ts:581,598). Not derivable from assetId, since
  // the same asset can appear as multiple children (reuse/repeat).
  id: string;
  // The child IS a pool asset — atomic OR another composite (recursion here).
  assetId: string;
  // Trim/placement, generalizing today's TimelineSegment in/out.
  sourceInSec?: number;
  sourceOutSec?: number;
  role?: string;               // which beat/scene this child serves
  reason?: string;             // rationale (today's TimelineSegment.reason)
  caption?: string;
};
```

**Mapping today → target (no information loss):**

- `Timeline` → a `CompositeAsset { compositeKind: "timeline" }` whose `children`
  are `CompositeChild` (from today's `TimelineSegment`); `aspectRatio/fps/
  showCaptions` move onto the composite (or a sibling `RenderHints`).
- `TimelineSegment { id, clipId, sourceInSec, sourceOutSec, role, reason,
  caption }` → `CompositeChild { id, assetId: clipId, sourceInSec,
  sourceOutSec, role, reason, caption }` (`src/lib/types.ts:177-185`).
  One-to-one; today's timeline is the degenerate single-level case. **The
  segment `id` is preserved on the child** (`CompositeChild.id ===
  TimelineSegment.id`) — it is required on the type (`src/lib/types.ts:178`),
  Remotion keys each `<Sequence>` by it (`src/remotion/VideoComposition.tsx:81`),
  and the edit graph addresses segments by it (`segmentId` on
  `VisualEntity`/`AudioEvent`, `src/lib/edit-graph/types.ts:425,435`; patch/
  decision lookups in `src/lib/edit-graph/schemas.ts:581,598`). Dropping it
  would break Remotion keying and orphan edit-graph patches, so the mapping is
  lossless only with the id carried through.
- `Clip` → `AtomicAsset` (`composite: false`) (`src/lib/types.ts:118-141`).
- `Project.timeline: Timeline | null` → `Project.rootCompositeId: string` (the
  top of the tree; pool ownership is lane 1). A flat short video is a root
  `timeline` composite of atomic clips — **identical to today**.

**Recursion / decomposition (the agent's call).**

```ts
// The agent decomposes a long target into a tree of composites it can fan out.
// movie ─┬─ sub_video(0-10min) ─┬─ scene ─┬─ clip(atomic)
//        │                      │         └─ clip(atomic)
//        │                      └─ scene  …
//        ├─ sub_video(10-20min) …   (independent → generate in PARALLEL)
//        └─ …
```

- A `CompositeChild.assetId` may point at another `CompositeAsset` → recursion.
- **Independence rule:** two composites are independently generable iff their
  **reachable subtrees are disjoint** — i.e. the sets of composites/assets each
  can reach by following `children[].assetId` share no node. (The weaker
  "neither is an ancestor of the other" is *not* sufficient: with
  reuse-by-reference two sibling composites can both reach a shared descendant,
  so scheduling them in parallel would duplicate or race that descendant's
  generation + stitch.) Composites with disjoint subtrees are the **unit of
  parallel fan-out** (lane 5/6 schedule them; we define the unit).
- **Scheduling implication:** when subtrees overlap (a shared descendant
  composite), the scheduler must **memoize/lock the shared node** — generate and
  stitch it once, then let both referencers consume its `stitchedAssetId` — so
  reuse-by-reference does not become duplicated work or a write race.
- **Reuse-by-reference:** a repeated scene = the same `CompositeAsset.id` listed
  as a child in multiple parents. No copy, no regeneration. (Edits to a shared
  composite ripple to all referencers — a signal for lane 2, the agent decides.)
  This sharing is exactly what makes pure ancestry insufficient for the
  independence test above.

**Stitching = a first-class, recursive operation that produces a new asset.**

```ts
// Pure-ish: resolve a composite's children (recursively materializing any
// child composites via their stitchedAssetId), concatenate, write ONE asset.
stitch(compositeId): Promise<{ stitchedAssetId: string }>
```

- Bottom-up: a `scene` stitches its clips → an atomic asset; a `sub_video`
  stitches the scenes' stitched assets; the `movie` stitches the sub-videos.
- Each stitch output is **persisted as a pool asset** (Principle 9), so a higher
  composite consumes it as `kind: "media"` and inspection (lane 7) can preview
  any sub-tree.
- The existing flat renderer (`src/remotion/VideoComposition.tsx:66-123`) becomes
  the **leaf stitcher** for a `timeline`/`scene` composite of atomic clips;
  higher-level stitching is concat of already-rendered sub-video assets (cheap).

**Composition tree = the dependency graph (shared with lane 2).** We do not add a
parallel edge set: a composite's `children[].assetId` **are** its outgoing
provenance edges ("stitched-from"); lane 2 attaches fingerprints/staleness to the
same nodes/edges and computes blast radius by walking this tree.

**`aiVideoProject.v1` reuse decision.** Keep it for *within-composite layering*:
a `timeline`/`scene` composite can compile to an `EditGraphTimeline`
(tracks/overlays/`OverlayAnchor`) when overlays/music are needed
(`src/lib/edit-graph/types.ts:339-384,290-295`). Do **not** try to express
recursion inside it (its `TimelineItem.source` has no composite kind). Recursion
lives in the thin `CompositeAsset` layer above; the edit-graph stays the leaf
representation.

## Work breakdown (ordered, PR-sized)

1. **Composite-asset type + timeline-as-composite adapter** (S–M). Add
   `AssetNode`/`CompositeAsset`/`CompositeChild` types; pure bidirectional
   adapters `Timeline ⇄ CompositeAsset{compositeKind:"timeline"}`. No behavior
   change; golden test: today's timelines round-trip byte-identically. *Touches
   `src/lib/types.ts` only; coordinate field-ownership with lane 1/4.*
2. **Recursive stitch function + leaf renderer reuse** (M). `stitch(compositeId)`
   that bottom-up materializes child composites and concatenates; leaf case
   delegates to the current Remotion path (`src/remotion/VideoComposition.tsx`).
   Persist each stitch output as a pool asset (via lane 1). Tests: 1-level
   (== today), 2-level, reuse (same child ID twice).
3. **`Project.rootCompositeId` projection** (S). Replace single `timeline` with a
   root composite reference; keep a compatibility getter that projects the root
   `timeline` composite back to `Timeline` so the editor/render keep working.
   *Cross-check store-consolidation (lane 4).*
4. **Decomposition tool contract (agent-driven)** (M). Define
   `decompose(target) → CompositeAsset tree (composites only, children empty)`
   and `compose(parentId, childIds)` as **agent tools** (impl owned by lane 6).
   The agent chooses split points; this PR ships the contract + a trivial
   default (single `timeline` composite = today) so nothing changes until the
   agent opts in.
5. **Parallel fan-out unit** (M, depends on unified-engine lane 5). Express
   "generate all leaf composites whose subtrees are independent in parallel" as a
   schedulable unit the engine runs; replace the sequential beat loop
   (`src/app/api/oneshot/route.ts:286-395`, `src/lib/runs/execute.ts:391-441`)
   with "generate-then-stitch over the composite tree." First pass for short
   videos = one composite = unchanged behavior.
6. **Reuse-by-reference + ripple signal** (S). Allow a composite ID to appear as
   a child of multiple parents; emit a "shared composite changed → these parents
   may be stale" signal for lane 2 (agent decides actuals).

Rough effort: ~2 S, ~4 M. P1-aligned (foundation, no UX change) for tasks 1-3;
tasks 4-6 are P2 (agent-driven) and gated on siblings 5/6.

## Dependencies & sequencing

- **Tasks 1-2 are no-regret** and can start immediately (pure types + adapters +
  stitch over today's data), independent of all siblings.
- **Task 3** should land with / after **store-consolidation (lane 4)** so
  `rootCompositeId` lives in the one project pool, not a second store.
- **Tasks 5-6 depend on unified-engine (lane 5)** (who runs the fan-out) and
  **orchestrator-tools (lane 6)** (who decides decomposition and drives it).
- **Lane 2 (provenance-graph)** consumes our tree as its graph — coordinate the
  edge naming (`children[].assetId` = "stitched-from") early so we don't define
  two overlapping edge sets.

## Risks & open questions

- **Double edge-set risk.** If lane 2 defines its own dependency edges separately
  from `CompositeChild`, the tree and the graph diverge — violating Principle 8's
  "same graph." *Mitigation:* agree the composite child reference IS the
  provenance edge before either lane ships edges.
- **Stitch cost/quality.** Re-encoding at every level is expensive and risks
  generation loss. *Open:* concat-without-re-encode (stream copy) for same-codec
  sub-videos vs. a single final render from a flattened leaf list. Lean toward
  stream-copy stitch for upper levels, full render only at leaves.
- **Trim/timing semantics across levels.** Today trim is per-segment seconds
  (`src/lib/types.ts:177-185`); the rich model is `...Ms`
  (`src/lib/edit-graph/types.ts`). *Open:* do composites carry `...Sec` (match
  current) or `...Ms`? Recommend matching current `...Sec` until a wholesale unit
  migration.
- **Where decomposition heuristics live.** Principle 8 says the **agent** decides
  — so the model must stay strictly declarative and never embed a "split every N
  minutes" rule. *Open question for lane 6:* what minimal signal (target length,
  scene count) does the agent get to drive the split?
- **Reuse + invalidation.** A shared composite edited in one context but not
  another is exactly the "stale is a signal, not a command" case
  (`docs/NORTH_STAR.md:38-41`); the boundary between this lane (the reference) and
  lane 2 (the staleness decision) must be crisp.
- **Aspect ratio / fps consistency** across stitched sub-videos — a child
  sub-video at the wrong aspect can't be concatenated cleanly; needs a
  validation contract (ties to Principle 7's tool-validates-its-inputs).
