# North Star — Store Consolidation Scope

> **Goal:** Collapse the codebase's *six* drifted persistence stores into **one
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

There are **six** separate persistence modules today, not two — the task brief
under-counts (`src/lib/api/v1/store.ts` is distinct from `src/lib/v1/store.ts`, and
two more *live* job stores back the agent-API surfaces). They use **five different
on-disk layouts** and there are **two `GenerationRun` definitions** (the dead one
was already removed — see below). The two job stores are easy to miss because
neither is named `store.ts`:

- `src/lib/api/v1/jobs.ts` persists generated-asset jobs to `.local/agent-jobs.json`
  (`src/lib/api/v1/jobs.ts:55-70`, `jobsFile()` → `localDir()` from `./store`),
  read/written via `createJob`/`updateJob`/`getJob` (`:90,107,119`). It is the
  async-job backing for the generated-assets pipeline
  (`src/lib/api/v1/generated-assets.ts:32` imports it).
- `src/lib/agent-api/jobs.ts` persists jobs **and** artifacts to `data/agent-jobs.json`
  (`src/lib/agent-api/jobs.ts:39` `this.file`, `:136-137` `agentApiStore =
  new AgentApiStore(path.join(process.cwd(), "data"))`). Its own `StoreShape`
  (`{ jobs, artifacts, idempotency }`, `:21-30`), read/written via
  `createOrGetJob`/`setStep`/`succeed`/`fail`/`saveArtifact`/`getArtifact`
  (`:63,106,110,117,121,128`). It backs the timeline revision / export / artifact
  v1 routes (`src/app/api/v1/projects/[projectId]/timelines/[timelineId]/revisions/route.ts:8`,
  `…/timelines/[timelineId]/exports/route.ts:8`,
  `src/app/api/v1/projects/[projectId]/artifacts/[artifactId]/route.ts:3`).

Note `src/lib/api/v1/jobs.ts` shares `data/agent-jobs.json`'s **filename** but not
its directory — one is under `.local/`, the other under `data/` — and the two carry
*different* `V1Job` vs `Job` shapes, so they are genuinely distinct stores, not one.

(The previously-listed dead run store under `src/lib/runs/` is **gone**:
`src/lib/runs/{store,types,execute}.ts` was deleted in PR #100 — merge commit
`e5a64fe`, "Delete dead async run pipeline (src/lib/runs/)". It is no longer a
store to consolidate, so the live count nets out at six.)

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
  - `src/lib/agent-api/http.ts` and `src/lib/agent-api/jobs.ts` (the latter being
    Store 6 below). (The former dead run executor `src/lib/runs/execute.ts` that
    also called `saveProject` was deleted in PR #100, `e5a64fe`.)

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

### Store 4 — generation-runs

- **LIVE:** `src/lib/v1/generation-runs/store.ts` persists the **`generation-runs`**
  collection under `.local/dev-db/` (reuses `defaultDbDir` from Store 3,
  `generation-runs/store.ts:4,73-74`). Its `GenerationRun` is defined in
  `src/lib/v1/types.ts:333-348` (status = `JobStatus`, no second taxonomy).
  Re-exported via `src/lib/v1/generation-runs.ts`. Read by the progress UI
  (`src/components/RunProgress.tsx`, `src/components/progress/**`) and the
  generations route.

> **Previously there was a second, dead run store** (`src/lib/runs/store.ts`,
> `.local/runs.json`, with its own duplicate `GenerationRun`/stage types in
> `src/lib/runs/types.ts`). It was **deleted in PR #100** (merge commit `e5a64fe`,
> "Delete dead async run pipeline (src/lib/runs/)") and is **no longer a
> consolidation target**. This also removed the second `GenerationRun` definition,
> so the `src/lib/v1/types.ts` one is now the only one.

### Store 5 — agent-API generated-asset job store (`src/lib/api/v1/jobs.ts`)

- **Backing file:** `.local/agent-jobs.json` (`src/lib/api/v1/jobs.ts:55-56`,
  `jobsFile()` joins `localDir()` from `./store` with `"agent-jobs.json"`). Single
  JSON doc, read-modify-write (`:61,70`).
- **Shape:** its own `V1Job` (`:37-53`) + `JobProgress` (`:32-36`) — a job/status
  taxonomy unrelated to Store 4's `GenerationRun`.
- **Read/write API:** `createJob` / `updateJob` / `getJob` (`:90,107,119`).
- **Who reads/writes it (LIVE):** the generated-assets pipeline
  `src/lib/api/v1/generated-assets.ts:32` (imports `createJob`/`getJob`/`updateJob`),
  which drives `/api/v1/projects/[projectId]/generated-assets/**`.

### Store 6 — agent-API jobs + artifacts store (`src/lib/agent-api/jobs.ts`)

- **Backing file:** `data/agent-jobs.json` (`src/lib/agent-api/jobs.ts:39`
  `this.file = path.join(baseDir, "agent-jobs.json")`; the singleton `agentApiStore`
  is constructed with `baseDir = path.join(process.cwd(), "data")`, `:136-137`).
  Same **filename** as Store 5 but a **different directory** (`data/` vs `.local/`)
  and a different record shape, so it is a genuinely separate store.
- **Shape:** `StoreShape = { jobs: Job[], artifacts: Artifact[], idempotency }`
  (`:21-30`) — carries **artifacts** (export outputs) in addition to jobs; a third
  job taxonomy distinct from both Store 4 and Store 5.
- **Read/write API:** `AgentApiStore` class (`:33`) — `getJob`, `createOrGetJob`,
  `setStep`, `succeed`, `fail`, `saveArtifact`, `getArtifact`
  (`:56,63,106,110,117,121,128`), serialized read-modify-write (`read`/`write`,
  `:42-54`).
- **Who reads/writes it (LIVE):** the timeline revision / export / artifact v1 routes
  via the `agentApiStore` singleton —
  `src/app/api/v1/projects/[projectId]/timelines/[timelineId]/revisions/route.ts:8`,
  `…/timelines/[timelineId]/exports/route.ts:8` (which also calls `saveArtifact`),
  and `src/app/api/v1/projects/[projectId]/artifacts/[artifactId]/route.ts:3`.

### Summary table

| Store | File | On-disk | projectId? | Live? |
|---|---|---|---|---|
| 1 Legacy `Project` | `src/lib/store.ts` | `data/project.json` (id `"default"`) | no (single doc) | **yes** — one-shot + studio editor |
| 2 Agent API | `src/lib/api/v1/store.ts` | `.local/agent-store.json` | yes (`V1Asset`) | yes — `/api/v1` projects/brief/assets |
| 3 Versioned v1 | `src/lib/v1/store.ts` | `.local/dev-db/<collection>/` | yes | yes — `/api/v1` generations + runs |
| 4 Runs (live) | `src/lib/v1/generation-runs/store.ts` | `.local/dev-db/generation-runs/` | yes | yes — progress UI |
| 5 Gen-asset jobs | `src/lib/api/v1/jobs.ts` | `.local/agent-jobs.json` | no (job-keyed) | yes — generated-assets pipeline |
| 6 Jobs + artifacts | `src/lib/agent-api/jobs.ts` | `data/agent-jobs.json` | no (job-keyed) | yes — timeline revisions / exports / artifacts |

> The old "4b" dead run store (`src/lib/runs/store.ts`, `.local/runs.json`) was
> deleted in PR #100 (`e5a64fe`) and is omitted from the table.

## Gap vs North Star

1. **Six stores, five layouts, two `V1Project`s, two `V1Asset`s, and three
   distinct job/run taxonomies** (`generation-runs` `GenerationRun`, Store 5
   `V1Job`, Store 6 `Job`+`Artifact`). North Star wants **one** project-scoped pool
   (§4, §8). (The previously-counted second `GenerationRun` and its dead run store
   are already gone — PR #100, `e5a64fe`.)
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

One module — call it the **project pool store** — replacing Stores 1–6 (the dead
run store 4b is already deleted, PR #100). It persists, per project, a **flat
immutable asset pool** plus a
small set of mutable "selection" documents (plan/timeline/graph) that point into
the pool by ID. Versioning is implicit: assets never mutate or delete; selections
move.

**Container hierarchy:** `Workspace → Project → { pool of assets, selection docs,
jobs, runs, idempotency }`. Local mode keeps a `dev_workspace` (matching
`api-contract-v1.md` local-mode behavior).

**Persistence layout (local):** keep the one-record-per-file directory style of
Store 3 (`.local/dev-db/`) — it is the only layout that scales to a large
never-deleted pool without rewriting a megabyte JSON doc on every append, and
already serializes cleanly per record. Drop the single-doc files
`data/project.json`, `.local/agent-store.json`, `.local/agent-jobs.json` (Store 5),
and `data/agent-jobs.json` (Store 6) — fold the latter two's job/artifact records
into per-project `jobs`/`runs`/`artifacts` collections under `.local/dev-db/`.

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

  // process records — subsumes Stores 4, 5, and 6 (runs, gen-asset jobs,
  // and jobs+artifacts), all project-scoped under one taxonomy
  getJob / saveJob ; getRun / saveRun
  getArtifact / saveArtifact            // exports etc., from Store 6
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
- **Fold in Stores 5 & 6 (the agent-API job stores):** reconcile the three job/run
  taxonomies (`generation-runs` `GenerationRun`, Store 5 `V1Job`, Store 6
  `Job`+`Artifact`) into one project-scoped `jobs`/`runs` collection plus an
  `artifacts` collection (Store 6 is the only one carrying export artifacts today).
  Point `src/lib/api/v1/generated-assets.ts` and the timeline
  revision/export/artifact routes at the consolidated job API; backfill
  `.local/agent-jobs.json` and `data/agent-jobs.json` once.
- **Keep from Store 1 (legacy `Project`), but *unbundle*:** its inline `clips`,
  `characterProfiles`/`characterReferences`, `compositions`, `plan`, `timeline`,
  `editGraph`, `critic`, `chat` become — respectively — pool assets (clips,
  character anchors), pool composites (compositions), and per-project selection
  docs (plan/timeline/graph). `chat`/`critic` become small per-project docs.
  Characters fold into the **anchor** model per the NORTH_STAR.md:270-272 decision
  (cross-ref: that retirement is owned by the anchor/character workstream; here we
  only stop persisting a separate `characterProfiles` array).
- **Drop entirely:** the `data/project.json` single mutable doc, the
  `.local/agent-store.json` layout (Store 2), the `.local/agent-jobs.json` +
  `data/agent-jobs.json` single-doc job stores (Stores 5 & 6) and their
  `src/lib/api/v1/jobs.ts` / `src/lib/agent-api/jobs.ts` modules. (The dead
  `src/lib/runs/` store + its duplicate `GenerationRun` were **already deleted in
  PR #100, `e5a64fe`** — nothing left to drop there.)

**Who writes it:** the **unified-engine** (sibling scope) becomes the sole writer
on the generation path; route handlers and the editor write only metadata /
selection moves. This doc does not build the engine — it provides the store the
engine writes through.

## Work breakdown (ordered, PR-sized)

1. **PR-A — Delete dead code (no behavior change).** ✅ **Done — PR #100 (`e5a64fe`)**
   removed `src/lib/runs/store.ts`, `src/lib/runs/types.ts`, `src/lib/runs/execute.ts`
   (verified unreferenced), dropping one `GenerationRun` definition and one store.
   *Effort: S.* (Step retained for history; no further work.)
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
4. **PR-C2 — Consolidate the agent-API job stores (Stores 5 & 6).** Reconcile the
   `V1Job` (`src/lib/api/v1/jobs.ts`) and `Job`+`Artifact` (`src/lib/agent-api/jobs.ts`)
   taxonomies with the `generation-runs` `GenerationRun` into the consolidated
   store's project-scoped `jobs`/`runs`/`artifacts` collections. Repoint
   `src/lib/api/v1/generated-assets.ts:32` and the timeline revision/export/artifact
   routes (`…/timelines/[timelineId]/revisions/route.ts:8`, `…/exports/route.ts:8`,
   `…/artifacts/[artifactId]/route.ts:3`); backfill `.local/agent-jobs.json` and
   `data/agent-jobs.json` once, then retire both modules. *Effort: M.* Can run in
   parallel with PR-D.
5. **PR-D — Compatibility / read-through shim for the legacy `Project`.** Implement
   the legacy `getProject`/`saveProject`/`addClip`/character/composition API
   **on top of** `ProjectStore` for `projectId = "default"`: reads compose a
   `Project` view from the pool + selection docs; writes fan out (new clips →
   `addAsset`; `timeline`/`plan` → selection docs). Behind a flag so the live
   one-shot + studio routes keep working byte-compatibly. Backfill
   `data/project.json` into the pool on first read. *Effort: L.* This is the
   critical de-risking step — both live surfaces flip with zero route changes.
6. **PR-E — Migrate the one-shot route + `project-cache.ts`.** Replace
   `savePartialProject` / `saveProject` / the `resumable*` helpers with
   `ProjectStore` calls (assets appended to pool; resume = read pool by goal/role
   instead of scanning the single doc). Coordinate with **unified-engine**
   (writer ownership). *Effort: M.*
7. **PR-F — Migrate the studio editor routes.** Move `/api/project`,
   `/api/generate`, `/api/revise`, `/api/generate-assets`, `/api/align-audio`,
   `/api/upload`, `/api/characters/**`, `/api/compositions/**`,
   `/api/assets/**/character-review`, `/api/export` off `@/lib/store` onto
   `ProjectStore`. Editor reads a composed project view; edits become
   selection-pointer moves (immutable assets). *Effort: L.*
8. **PR-G — Remove the legacy store + shim.** Delete `src/lib/store.ts`, the
   `Project` inline-collection type usage, and `data/project.json`. One store
   remains. *Effort: S.*

## Dependencies & sequencing

- **PR-A → done** (PR #100, `e5a64fe` — dead run path + duplicate `GenerationRun`
  already removed). No remaining work; everything below builds on the smaller surface.
- **PR-B → independent**, can run in parallel; must land before PR-C.
- **PR-C depends on asset-pool** finalizing the asset field set (kind / role /
  depicts / provenance). If asset-pool slips, PR-C can land with a minimal asset
  shape and asset-pool extends it.
- **PR-C2 depends on PR-C** (needs the consolidated job/run/artifact collections);
  independent of PR-D and can run in parallel with it.
- **PR-D depends on PR-C.** PR-E and PR-F both depend on PR-D (the read-through
  shim lets them migrate independently and incrementally).
- **PR-E/PR-F should be sequenced with unified-engine:** unified-engine wants to
  be the sole writer on the generation path, so PR-E (one-shot) ideally lands
  *with or just after* the unified engine, not before — otherwise we migrate the
  one-shot writes twice. **Open coordination point with unified-engine.**
- **PR-G last**, only after E + F (and PR-C2) all land and the shim is unused —
  one store remains.
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
