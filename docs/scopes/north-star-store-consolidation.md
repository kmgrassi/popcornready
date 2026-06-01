# North Star — Store Consolidation Scope

> **Goal:** Collapse the codebase's *four* drifted persistence stores into **one
> project-scoped asset pool** (every asset carries `projectId`; immutable pooled
> assets + moving selections give versioning for free), and migrate the live
> studio editor + one-shot route onto it via a compatibility/read-through phase.

## Status & sibling cross-refs

- **Status:** P0 design / scoping only. No code. This is one workstream of the
  North Star initiative ([`docs/NORTH_STAR.md`](../NORTH_STAR.md), esp. §4 +
  §8 "collapse to one project-scoped asset pool").
- **My lane:** *store-consolidation* — the persistence layer and the migration of
  the live surfaces onto it.
- **Sibling workstreams (cross-reference, do not redo):**
  - **asset-pool** — defines *what* a pooled asset is (kind, self-describing
    provenance, role/what-it-depicts). This doc consumes that shape; it does not
    define the asset schema. Where I say "pooled asset" the asset-pool scope owns
    the fields.
  - **provenance-graph** — input-IDs / fingerprints / staleness *carried on the
    asset*. My store persists those fields opaquely; it does not compute them.
  - **composition** — the recursive atomic/composite asset model. A composite is
    just another pooled asset with child IDs + selections; my store treats it as
    one more row.
  - **unified-engine** — collapses the one-shot route and the async run pipeline
    into one engine. That engine becomes the **sole writer** of the consolidated
    store. Sequencing with unified-engine is called out in
    [Dependencies & sequencing](#dependencies--sequencing).
  - **orchestrator-tools** / **inspection-feedback** — downstream readers of the
    pool; out of scope here beyond "they read by `projectId` + asset ID."

## North Star alignment

This scope implements the two resolved §8 decisions that are pure persistence:

- *"Trunk for creative state — DECIDED: collapse to one project-scoped asset pool
  (no dual store)."* (NORTH_STAR.md:252-257)
- *"Re-run downstream policy — DECIDED: an asset pool model — assets are immutable
  and never deleted; each location has an active selection."* (NORTH_STAR.md:247-251)

And §5: *"One project-scoped asset pool — not multiple stores … every asset carries
a `projectId` and lives in a single flat pool … Versioning falls out for free:
assets are immutable in the pool, selections move."* (NORTH_STAR.md:193-204).

The store layer is **no-regret**: every other North Star workstream (provenance
edges, orchestrator, inspection) reads and writes through it, so consolidating it
first removes the dual-store tax they would otherwise each pay.

## Current state (grounded)

There are **four** separate persistence modules today, not two — the task brief
under-counts by one (`src/lib/api/v1/store.ts` is distinct from
`src/lib/v1/store.ts`). They use **three different on-disk layouts** and there are
**two `GenerationRun` definitions**, one of which is dead.

### Store 1 — legacy single-project store (`src/lib/store.ts`)

- **Backing file:** `data/project.json` (`src/lib/store.ts:16-17`). Single mutable
  document, hard-coded id `"default"` (`src/lib/store.ts:55`, `emptyProject()`).
- **Shape:** `Project` (`src/lib/types.ts:375-392`) — one doc holding `plan`,
  `timeline`, `editGraph`, `clips: Clip[]`, `characterProfiles`,
  `characterReferences`, `compositions`, `assetGenerationJobs`, `critic`, `chat`.
  Everything lives inline; there is no per-asset addressability beyond `Clip.id`
  inside the array.
- **Read/write API:** `getProject` / `saveProject` (read-modify-write the whole
  doc, `:79-95`), plus `addClip`, the `characterProfile` / `characterReference`
  CRUD, `updateGeneratedAssetReview`, `saveComposition` / `getComposition` /
  `findCompositionByIdempotencyKey` (`:97-285`).
- **Who reads/writes it (the LIVE surface):**
  - One-shot route `src/app/api/oneshot/route.ts:3,481` (`saveProject`) +
    `savePartialProject` from `src/app/api/oneshot/project-cache.ts:4,53` (writes
    the whole `Project` mid-run; also the read-through resume helpers
    `resumableClipsForGoal` / `resumableSoundtrackForGoal` /
    `resumableCharacterForGoal`, `:84-144`).
  - Studio editor routes (the React editor at `src/app/studio/page.tsx` →
    `src/components/Editor.tsx` fetches): `/api/project`
    (`src/app/api/project/route.ts`), `/api/generate`, `/api/revise`,
    `/api/export`, `/api/generate-assets`, `/api/align-audio`, `/api/upload`,
    `/api/characters/**`, `/api/compositions/**`,
    `/api/assets/[assetId]/character-review` — all import `@/lib/store`
    (enumerated by `grep -rln @/lib/store src`; 16 route files).
  - The dead run executor `src/lib/runs/execute.ts:15,528` (`saveProject`) — see
    Store 4.
  - `src/lib/agent-api/http.ts` and `src/lib/agent-api/jobs.ts`.

### Store 2 — agent API store (`src/lib/api/v1/store.ts`)

- **Backing file:** `.local/agent-store.json` (`src/lib/api/v1/store.ts:95-97`).
  Single JSON doc with arrays `workspaces`, `projects`, `briefVersions`, `assets`,
  `idempotency` (`:79-86`), serialized read-modify-write (`mutate`, `:135-150`).
- **Shape:** its own `V1Project` (carries `brief` + `currentBriefVersionId`,
  `:30-40`), `V1BriefVersion`, `V1Asset` (carries `workspaceId` + `projectId` +
  `provenance`, `:50-68`). **`V1Asset` already carries `projectId`** — the closest
  thing to the North Star pooled asset today.
- **Read/write API:** `createProject` / `getProject(workspaceId, projectId)` /
  `listProjects`, `setBrief` / `createBriefVersion`, `addAsset` / `getAsset` /
  `listAssets`, idempotency records, with cursor `paginate` (`:152-178`).
- **Who reads/writes it:** the `/api/v1` route handlers —
  `src/app/api/v1/projects/route.ts:4`, `[projectId]/route.ts`,
  `[projectId]/brief{,-versions}/route.ts`, `[projectId]/assets/**`,
  `[projectId]/generated-assets/**`, `health/route.ts`, `me/route.ts`.

### Store 3 — versioned v1 store (`src/lib/v1/store.ts`)

- **Backing dir:** `.local/dev-db/<collection>/<id>.json`
  (`src/lib/v1/store.ts:142-146`, `defaultDbDir`), one file per record.
- **Collections (`COLLECTIONS`, `:53-62`):** `projects`, `brief-versions`,
  `assets`, `compositions`, `edit-graphs`, `jobs`, `timelines`, `idempotency`.
  (The live **generation-runs** collection also lives under this dir — see Store 4.)
- **Shape:** a *different* `V1Project` (no `brief` field; `:32-40` of
  `src/lib/v1/types.ts`), `V1Asset` *also* carrying `projectId` + `workspaceId`
  (`src/lib/v1/types.ts:81-97`), `CompositionPlan`, `VersionedTimeline` with the
  rich `TimelineProvenance` (`briefVersionId`, `compositionId`, `sourceAssetIds`,
  `generatedAssetJobIds`, `criticReport`, `derivedFrom.editGraphId`,
  `src/lib/v1/types.ts:187-217` — the strongest lineage record in the repo, per
  NORTH_STAR.md:114-117), `VersionedEditGraph`, `Job`.
- **Read/write API:** `V1Store` interface (`:28-51`) — `getProject` /
  `getBriefVersion` / `getAsset` / `listAssets` / `getComposition` (reads),
  `getJob`/`saveJob`, `getEditGraph`/`saveEditGraph`, `getTimeline`/`saveTimeline`,
  idempotency, plus "seed writers" `saveProject` / `saveBriefVersion` /
  `saveAsset` / `saveComposition`.
- **Who reads/writes it:** `/api/v1/projects/[projectId]/generations/route.ts:9`
  and `generations/[jobId]/route.ts` via `getStore()`. **Note the split:** within
  `/api/v1`, the *projects/brief/assets* routes use **Store 2** while the
  *generations* route uses **Store 3** — two stores behind one API surface, with
  two incompatible `V1Project`/`V1Asset` definitions
  (`src/lib/api/v1/store.ts` vs `src/lib/v1/types.ts`).

### Store 4 — generation-runs + the dead legacy run store

There are **two `GenerationRun` definitions** and **two run stores**; only one is live.

- **LIVE:** `src/lib/v1/generation-runs/store.ts` persists the **`generation-runs`**
  collection under `.local/dev-db/` (reuses `defaultDbDir` from Store 3,
  `generation-runs/store.ts:4,73-74`). Its `GenerationRun` is defined in
  `src/lib/v1/types.ts:333-348` (status = `JobStatus`, no second taxonomy).
  Re-exported via `src/lib/v1/generation-runs.ts`. Read by the progress UI
  (`src/components/RunProgress.tsx`, `src/components/progress/**`) and the
  generations route.
- **DEAD:** `src/lib/runs/store.ts` (`.local/runs.json`, `:23-24`) with its own
  `GenerationRun` / stage types in `src/lib/runs/types.ts:86-103`. Its only
  importer is `src/lib/runs/execute.ts:39` (`./store`); `runs/execute.ts` is
  imported by **nobody** (verified: `grep -rn runs/execute src` matches only the
  file itself). This is the orphaned pre-unification run pipeline — a cleanup
  target, not a migration target.

### Summary table

| Store | File | On-disk | projectId? | Live? |
|---|---|---|---|---|
| 1 Legacy `Project` | `src/lib/store.ts` | `data/project.json` (id `"default"`) | no (single doc) | **yes** — one-shot + studio editor |
| 2 Agent API | `src/lib/api/v1/store.ts` | `.local/agent-store.json` | yes (`V1Asset`) | yes — `/api/v1` projects/brief/assets |
| 3 Versioned v1 | `src/lib/v1/store.ts` | `.local/dev-db/<collection>/` | yes | yes — `/api/v1` generations + runs |
| 4a Runs (live) | `src/lib/v1/generation-runs/store.ts` | `.local/dev-db/generation-runs/` | yes | yes — progress UI |
| 4b Runs (dead) | `src/lib/runs/store.ts` | `.local/runs.json` | yes | **no** — orphaned |

## Gap vs North Star

1. **Four stores, three layouts, two `V1Project`s, two `V1Asset`s, two
   `GenerationRun`s.** North Star wants **one** project-scoped pool (§4, §8).
2. **The live creative surface (one-shot + studio) is on the *worst* store** —
   the single mutable `Project` doc at id `"default"` (`store.ts:55`), which has
   no `projectId` per asset, no multi-project support, and clobbers prior state
   on every `saveProject` (NORTH_STAR.md:153-154 calls this out as the model to
   *not* entrench).
3. **No pool semantics anywhere.** Assets are not immutable: the studio editor
   mutates the single doc in place; regeneration overwrites rather than adding to
   a pool with a moving active selection (the §8 "re-run downstream policy"
   decision). `Clip[]` + `TimelineSegment.clipId` is a *partial* pool for video
   only (NORTH_STAR.md:188-191), not generalized to anchors/keyframes/audio.
4. **Assets are not self-describing across kinds.** `Clip.generatedBy` /
   `characterBinding` do "half of this" (NORTH_STAR.md:204) for video; images /
   audio / anchors carry no consistent provenance/role — the prerequisite the
   North Star names for an agent to reason by ID.
5. **Workspaces split inconsistently.** Stores 2 & 3 are `workspaceId`-scoped;
   Store 1 has no workspace at all. Consolidation must pick one scoping rule
   (project-scoped, workspace deferred — NORTH_STAR.md:258-260).

## Target design (one store interface)

One module — call it the **project pool store** — replacing Stores 1–3 (and
deleting 4b). It persists, per project, a **flat immutable asset pool** plus a
small set of mutable "selection" documents (plan/timeline/graph) that point into
the pool by ID. Versioning is implicit: assets never mutate or delete; selections
move.

**Container hierarchy:** `Workspace → Project → { pool of assets, selection docs,
jobs, runs, idempotency }`. Local mode keeps a `dev_workspace` (matching
`api-contract-v1.md` local-mode behavior).

**Persistence layout (local):** keep the one-record-per-file directory style of
Store 3 (`.local/dev-db/`) — it is the only layout that scales to a large
never-deleted pool without rewriting a megabyte JSON doc on every append, and
already serializes cleanly per record. Drop `data/project.json` and
`.local/agent-store.json`.

**Interface sketch (names illustrative; asset *fields* owned by asset-pool scope):**

```
interface ProjectStore {
  // projects / workspaces
  getProject(workspaceId, projectId): Promise<Project | null>
  listProjects(workspaceId, page): Promise<Page<Project>>
  saveProject(project): Promise<Project>            // metadata only, soft-delete

  // the pool — immutable, append-only, never deleted
  addAsset(asset): Promise<Asset>                   // asset carries projectId + provenance + role
  getAsset(projectId, assetId): Promise<Asset | null>
  listAssets(projectId, filter?): Promise<Asset[]>  // by kind / role / depicts

  // selection docs — the only mutable references into the pool
  getPlan(projectId): / savePlan
  getTimeline(projectId, timelineId): / saveTimeline   // active-selection pointers
  getEditGraph / saveEditGraph
  // briefVersions remain immutable, addressable

  // process records
  getJob / saveJob ; getRun / saveRun
  getIdempotency / saveIdempotency
}
```

**What to keep vs drop:**

- **Keep from Store 3 (the trunk):** the per-record directory layout, the
  `VersionedTimeline` + `TimelineProvenance` lineage shape (the richest in the
  repo), `Job`, `VersionedEditGraph`, idempotency, the `generation-runs`
  collection. Store 3 is the closest existing thing to the target and should be
  the **base** the consolidated store grows from.
- **Keep from Store 2:** the `brief` / `currentBriefVersionId` project fields and
  cursor `paginate`; fold them into Store 3's project record. Reconcile the two
  `V1Project`/`V1Asset` definitions into one (`V1Asset` already has `projectId` —
  extend with the self-describing `kind`/`role`/`depicts`/`provenance` fields the
  asset-pool scope defines).
- **Keep from Store 1 (legacy `Project`), but *unbundle*:** its inline `clips`,
  `characterProfiles`/`characterReferences`, `compositions`, `plan`, `timeline`,
  `editGraph`, `critic`, `chat` become — respectively — pool assets (clips,
  character anchors), pool composites (compositions), and per-project selection
  docs (plan/timeline/graph). `chat`/`critic` become small per-project docs.
  Characters fold into the **anchor** model per the NORTH_STAR.md:270-272 decision
  (cross-ref: that retirement is owned by the anchor/character workstream; here we
  only stop persisting a separate `characterProfiles` array).
- **Drop entirely:** the `data/project.json` single mutable doc, the
  `.local/agent-store.json` layout, the dead `src/lib/runs/store.ts` +
  `src/lib/runs/types.ts` + `src/lib/runs/execute.ts`, and the
  `src/lib/runs/types.ts` `GenerationRun`/stage duplicate (the
  `src/lib/v1/types.ts` ones win).

**Who writes it:** the **unified-engine** (sibling scope) becomes the sole writer
on the generation path; route handlers and the editor write only metadata /
selection moves. This doc does not build the engine — it provides the store the
engine writes through.

## Work breakdown (ordered, PR-sized)

1. **PR-A — Delete dead code (no behavior change).** Remove
   `src/lib/runs/store.ts`, `src/lib/runs/types.ts`, `src/lib/runs/execute.ts`
   (verified unreferenced). Removes one `GenerationRun` definition and one store.
   *Effort: S.* Pure deletion; de-risks everything after.
2. **PR-B — Reconcile the two v1 stores' types.** Unify Store 2 and Store 3's
   `V1Project` / `V1Asset` into the `src/lib/v1/types.ts` definitions (add
   `brief`/`currentBriefVersionId`, keep `projectId`). Point the `/api/v1`
   projects/brief/assets routes at Store 3 (`getStore()`); migrate any
   `.local/agent-store.json` data with a one-shot backfill. Retire
   `src/lib/api/v1/store.ts`. *Effort: M.* Collapses 2 stores → 1 behind `/api/v1`.
3. **PR-C — Define the consolidated `ProjectStore` interface + pool collection.**
   Land the interface above over Store 3's layout: add an `assets` pool with the
   self-describing fields (coordinated with asset-pool scope), `addAsset`
   (append-only), `listAssets(filter)`, and selection-doc accessors. No callers
   migrated yet. *Effort: M.*
4. **PR-D — Compatibility / read-through shim for the legacy `Project`.** Implement
   the legacy `getProject`/`saveProject`/`addClip`/character/composition API
   **on top of** `ProjectStore` for `projectId = "default"`: reads compose a
   `Project` view from the pool + selection docs; writes fan out (new clips →
   `addAsset`; `timeline`/`plan` → selection docs). Behind a flag so the live
   one-shot + studio routes keep working byte-compatibly. Backfill
   `data/project.json` into the pool on first read. *Effort: L.* This is the
   critical de-risking step — both live surfaces flip with zero route changes.
5. **PR-E — Migrate the one-shot route + `project-cache.ts`.** Replace
   `savePartialProject` / `saveProject` / the `resumable*` helpers with
   `ProjectStore` calls (assets appended to pool; resume = read pool by goal/role
   instead of scanning the single doc). Coordinate with **unified-engine**
   (writer ownership). *Effort: M.*
6. **PR-F — Migrate the studio editor routes.** Move `/api/project`,
   `/api/generate`, `/api/revise`, `/api/generate-assets`, `/api/align-audio`,
   `/api/upload`, `/api/characters/**`, `/api/compositions/**`,
   `/api/assets/**/character-review`, `/api/export` off `@/lib/store` onto
   `ProjectStore`. Editor reads a composed project view; edits become
   selection-pointer moves (immutable assets). *Effort: L.*
7. **PR-G — Remove the legacy store + shim.** Delete `src/lib/store.ts`, the
   `Project` inline-collection type usage, and `data/project.json`. One store
   remains. *Effort: S.*

## Dependencies & sequencing

- **PR-A → independent**, do first (deletes the dead run path, removes a duplicate
  `GenerationRun`).
- **PR-B → independent of A**, can run in parallel; both must land before PR-C.
- **PR-C depends on asset-pool** finalizing the asset field set (kind / role /
  depicts / provenance). If asset-pool slips, PR-C can land with a minimal asset
  shape and asset-pool extends it.
- **PR-D depends on PR-C.** PR-E and PR-F both depend on PR-D (the read-through
  shim lets them migrate independently and incrementally).
- **PR-E/PR-F should be sequenced with unified-engine:** unified-engine wants to
  be the sole writer on the generation path, so PR-E (one-shot) ideally lands
  *with or just after* the unified engine, not before — otherwise we migrate the
  one-shot writes twice. **Open coordination point with unified-engine.**
- **PR-G last**, only after E + F both land and the shim is unused.
- **provenance-graph** consumes the per-asset fields PR-C adds; it can proceed in
  parallel once PR-C's asset shape is stable (it writes fingerprints/input-IDs
  *onto* the assets this store persists opaquely).

## Risks & open questions

1. **Byte-compatibility of the legacy `Project` view (PR-D).** The studio editor
   and one-shot route read a fully-populated `Project` with inline `clips` /
   `timeline` / `editGraph`. Recomposing that view from a pool + selection docs
   must be exact, or the editor breaks subtly. *Mitigation: PR-D is read-through
   behind a flag with golden-file comparison against `data/project.json`.*
2. **Single id `"default"` everywhere.** Studio hard-codes `PROJECT_ID =
   "default"` (`src/app/studio/page.tsx:8`) and the legacy store hard-codes id
   `"default"` (`store.ts:55`). Multi-project is real in Stores 2/3 but the live
   UI assumes one project. *Open: do we keep `"default"` as the local single
   project, or does the editor gain a project selector? Defer the selector;
   keep `"default"` as the local workspace's lone project for now.*
3. **Workspace scoping mismatch.** Stores 2/3 require `workspaceId`; Store 1 has
   none. *Resolution: project-scoped now, `dev_workspace` in local mode
   (api-contract-v1.md); workspace-level cross-video reuse deferred per
   NORTH_STAR.md:258-260.*
4. **Immutability vs today's in-place edits.** The editor today mutates the doc
   (character review, clip edits). The pool forbids mutating assets. Mutable
   *metadata* (e.g. `consistencyReview` in `updateGeneratedAssetReview`,
   `store.ts:239-255`) must be modeled either as a side-doc keyed by assetId or as
   a new pooled review asset. *Open question for asset-pool: where do mutable
   review annotations live if assets are immutable?*
5. **Two v1 stores behind one API (Store 2 vs 3).** Reconciling the two
   `V1Project`/`V1Asset` shapes (PR-B) may surface fields each has that the other
   lacks (Store 2 `brief`/`currentBriefVersionId` + `idempotency` array vs Store 3
   per-file idempotency). *Mitigation: superset the fields; backfill once.*
6. **Local data loss / migration ordering.** `data/project.json` and
   `.local/agent-store.json` hold real local dev state. Backfills (PR-B, PR-D)
   must be idempotent and non-destructive (copy, never move, until PR-G).
7. **Coordination with unified-engine on writer ownership (see sequencing).**
   The biggest cross-lane risk: migrating one-shot writes (PR-E) before vs after
   the engine unification determines whether we pay the migration cost once or
   twice.
