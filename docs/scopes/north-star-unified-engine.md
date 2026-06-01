# North Star — Unified Generation Engine

> **One-line goal:** Collapse the live synchronous one-shot pipeline and the
> dormant async run twin into a **single staged generation engine**, where the
> run is the trunk and both a synchronous entry and a background run are thin
> wrappers — killing the duplicated helpers (and the real 1:1 aspect-ratio bug)
> along the way.

## Status & sibling cross-references

- **Status:** Scoping / proposal. No implementation yet. This is one workstream
  of the North Star initiative (`docs/NORTH_STAR.md`), aligned to its
  **P1 — Foundation** phase (§7), specifically Principle 6 ("One engine").
- **My lane:** unified-engine — the staged engine and its sync/async wrappers.
- **Stay-in-lane cross-references** (these workstreams own the cited concerns;
  this doc consumes their contracts rather than redefining them):
  - **store-consolidation** — owns the *one* `GenerationRun` / project-pool data
    model. This doc assumes a single run model exists and wraps it; it does
    **not** design the persistence schema. Today there are two+ competing
    `GenerationRun` definitions (see Current State); consolidation lives there.
  - **orchestrator-tools** — owns "stages-as-tools": each stage becomes a
    granular, idempotent, self-validating tool the agent calls
    (`docs/NORTH_STAR.md` §6, Principle 7). This doc defines the *staged engine*
    that those tools are eventually carved from; it is the deterministic
    first-pass driver the orchestrator later replaces/augments.
  - **inspection-feedback** — owns stage progress emission, review gates, and
    the artifact-as-it-pops UX (`docs/scopes/generation-progress-ui.md`,
    `docs/scopes/generation-review-checkpoints.md`). This doc defines the
    **emit-points** (the `onStage`/`onArtifact` seam) but not the UI or gate
    policy.
  - **asset-pool / provenance-graph / composition** — own where artifacts land
    (the immutable project pool), what edges they carry, and recursive
    composites. This doc only specifies that the engine **emits artifacts as it
    completes stages** through a sink those workstreams provide.

## North Star alignment

This workstream is the concrete delivery of **Principle 6 — One engine**
(`docs/NORTH_STAR.md:51-53`): *"The synchronous one-shot route and the async run
pipeline converge into a single engine. The staged 'run' model is the trunk; the
quick call becomes a thin entry into it."*

It is explicitly called out in **P1 — Foundation**
(`docs/NORTH_STAR.md:226-230`): *"unify the two pipelines into one engine (kills
the drift, e.g. the 1:1 size mismatch). Everything becomes observable and
re-runnable."* §3 names *"two drifted pipelines … and two `GenerationRun`
definitions"* (`docs/NORTH_STAR.md:96-98`) and §4 lists *"Two drifted
run/pipeline models"* among the gaps (`docs/NORTH_STAR.md:154`).

The unified engine is the **autonomous-by-default** runner of Principle 2
(`docs/NORTH_STAR.md:32-34`): with no gates it runs straight through (today's
one-shot behavior, just observable); gates and selective regeneration land on
top of it in later phases. It is also the body that orchestrator-tools later
decompose into self-validating tools (Principle 7) — so the staged engine must
be structured as **discrete, individually-callable stages**, not a monolith.

## Current state (cited)

### The two pipelines

1. **LIVE synchronous pipeline — `src/app/api/oneshot/route.ts`.**
   - One blocking `POST` handler (`src/app/api/oneshot/route.ts:180`),
     `maxDuration = 800` (line 52). It runs, in order: plan
     (`planEdit`, line 200) → pre-gen plan critique (`critiquePlan`, line 219) →
     character hero frame (`generateCharacterHeroFrame`, line 237) → per-beat
     keyframe + clip with inline video-snapshot review/regenerate
     (`generateBeatKeyframe` line 309, `generateBeatClipWithReview` line 326) →
     soundtrack in parallel (line 260) → timeline assembly via edit graph
     (line 427) → post critique + patch (`critique`, line 444) → `saveProject`
     (line 481).
   - **Called by** `src/components/Editor.tsx:245` and
     `src/components/PromptComposer.tsx:194` — this is the only generation path
     the product actually invokes today.
   - Persists incrementally via `savePartialProject` (lines 342, 382, 399) so a
     crash leaves resumable clips; resume helpers
     (`resumableClipsForGoal` / `resumableCharacterForGoal` /
     `resumableSoundtrackForGoal`) live in `src/app/api/oneshot/project-cache.ts`.
   - Helpers re-exported through `src/app/api/oneshot/helpers.ts` (a 4-line
     barrel) from `config.ts`, `media-generation.ts`, `prompts.ts`,
     `project-cache.ts`.

2. **DORMANT async twin — `src/lib/runs/execute.ts`.**
   - `executeRun(run: GenerationRun)` (`src/lib/runs/execute.ts:298`) reimplements
     the same flow — `markRunRunning` → `brief_intake` →
     `creative_plan` (plan + critique) → `asset_generation` (per-beat loop) →
     `timeline_assembly` → `quality_review` → `ready` — writing stage progress
     into a `runs.json` store (`src/lib/runs/store.ts`).
   - **`executeRun` has NO caller.** `grep -rn "executeRun" src/` returns only
     its own definition. Nothing outside `src/lib/runs/` imports `lib/runs` at
     all — the entire directory (`execute.ts`, `store.ts`, `types.ts`) is
     orphaned dead code.

### A third, adjacent surface (context, not in-lane to rewrite)

`src/lib/v1/generation-runs/` + `src/app/api/v1/projects/[projectId]/generation-runs/**`
is a **separate** run system: a real polling API (create/get/list/cancel/retry/
approve/reject routes) with its own store, `progress-emitter.ts`, and review-gate
machinery. But its create route only *seeds queued stages*
(`src/app/api/v1/projects/[projectId]/generation-runs/route.ts:16` comment:
*"Backend progress emission (scope PR 3) wires real stage transitions"*) — it
does **no real generation** (no `planEdit` / `generateBeatClip` /
`generateAsset` anywhere under `src/lib/v1/generation-runs/`). The live runs page
(`src/app/projects/[projectId]/runs/[runId]/page.tsx:12`) renders this v1 store.
So today: one path generates (oneshot, no run model), one path models runs
without generating (v1 generation-runs), and one path does both but is dead
(`src/lib/runs`). **store-consolidation** owns reconciling the run model; this
doc must wrap whichever single model survives.

### Duplicated helpers (the drift — enumerated)

| Helper | LIVE (oneshot) | DORMANT (execute.ts) | Drift |
| --- | --- | --- | --- |
| `resolveVideoProviders` | `src/app/api/oneshot/config.ts:10` — takes `body`, honors explicit `provider`/`mock` requests, full validation | `src/lib/runs/execute.ts:50` — takes no args, ignores requested provider | execute.ts cannot honor a requested provider; diverged signatures |
| `videoSizeForAspect` | `src/app/api/oneshot/config.ts:109` — **1:1 → `1280x720`** | `src/lib/runs/execute.ts:69` — **1:1 → `1024x1024`** | **REAL BUG: same aspect ratio yields different output sizes** (see below) |
| `clampSeconds` | `src/app/api/oneshot/config.ts:115` — `normalizeOpenAIVideoSeconds(...)` (typed `OpenAIVideoSeconds`) | `src/lib/runs/execute.ts:75` — `Math.min(8, Math.max(4, round))` (plain number) | different clamping logic + return type |
| `beatPrompt` | `src/app/api/oneshot/prompts.ts:26` — rich: takes `plan`, full beat map, prev/next beat continuity, character-invariants block | `src/lib/runs/execute.ts:80` — simple: goal + single beat, no plan/anchors | execute.ts produces materially weaker prompts |
| `generateBeatClip` | `src/app/api/oneshot/media-generation.ts:22` — supports `characterContext`, `firstFramePath` keyframe, builds `characterBinding`, reference paths | `src/lib/runs/execute.ts:95` — bare prompt→clip, no character/keyframe/binding support | the task brief's claim that `generateBeatClip` is "already shared" in `src/lib/generative/beat-clip.ts` is **stale**: that file does not exist; there are two independent copies |
| `newId` / `newAssetId` | `src/app/api/oneshot/config.ts:6` (`newId`) | `src/lib/runs/execute.ts:46` (`newAssetId`) | identical impl, two names |
| `isQuotaError` | `src/app/api/oneshot/media-generation.ts:106` | `src/lib/runs/execute.ts:274` | identical impl, copy-pasted |
| `optionalOneShotStep` / `optionalRunStep` | `src/app/api/oneshot/media-generation.ts:116` | `src/lib/runs/execute.ts:157` | identical impl, two names |
| `attachVideoReview` | `src/app/api/oneshot/route.ts:54` | `src/lib/runs/execute.ts:169` | near-identical (oneshot handles both binding slots more defensively) |
| `reviewClipIfPossible` | `src/app/api/oneshot/route.ts:75` | `src/lib/runs/execute.ts:189` | duplicated; oneshot passes `characterProfiles`/`heroReferencePath`, execute.ts does not |
| `promptWithVisualFeedback` | `src/app/api/oneshot/route.ts:101` | `src/lib/runs/execute.ts:211` | byte-identical copy |
| `generateBeatClipWithReview` | `src/app/api/oneshot/route.ts:113` | `src/lib/runs/execute.ts:223` | duplicated review/retry loop |

### The 1:1 drift, precisely

- `videoSizeForAspect("1:1")` returns **`"1280x720"`** in
  `src/app/api/oneshot/config.ts:111`.
- `videoSizeForAspect("1:1")` returns **`"1024x1024"`** in
  `src/lib/runs/execute.ts:71`.
- The oneshot value (`1280x720`) for a `1:1` request is itself wrong (it is
  16:9, not square) — but it is the value the live product actually uses. The
  two functions disagreeing means whichever pipeline runs silently changes the
  output geometry. **Unifying to one helper forces resolving the correct square
  size** (e.g. `1024x1024` / a provider-supported square) in exactly one place.

### Two `GenerationRun` type definitions (drift in the model)

- `src/lib/runs/types.ts:86` — the dormant engine's `GenerationRun`
  (with `inputs`, `stages`, embedded `GenerationStage[]`).
- `src/lib/v1/types.ts:333` — the v1 polling surface's `GenerationRun`
  (gate-aware, `GenerationRunStatus = JobStatus`, stages stored separately).
- Both declare overlapping `GenerationStageType`, `ReviewGateConfig`,
  `RunReviewGate`, `GenerationErrorSummary`, `GenerationStageItem`,
  `GenerationStage` with subtle differences (e.g. `retryable` required vs
  optional; `RUN_STAGES` omits `audio_generation`/`export`,
  `src/lib/runs/types.ts:105`). **store-consolidation owns picking the
  survivor**; this doc's engine targets whichever one wins.

## Gap vs North Star

1. **No single engine.** The only thing the product runs is a monolithic route
   handler (`src/app/api/oneshot/route.ts`) whose stages are inlined `await`s,
   not callable units. The "run as trunk" the North Star wants (Principle 6)
   exists only as dead code (`executeRun`) and as a non-generating polling
   surface (`v1/generation-runs`). There is no shared engine for a sync entry
   and an async run to wrap.
2. **Drift is shipping risk.** Eleven-plus duplicated helpers (above) mean any
   fix to provider selection, prompting, clamping, or character handling must be
   made twice and is already inconsistent (the 1:1 bug, the weaker `beatPrompt`,
   the character-less `generateBeatClip`). This is the exact drift P1 calls out.
3. **Stages are not observable from the live path.** The live pipeline only
   emits `console.info` and `savePartialProject`; there is no structured
   per-stage progress/artifact emission (inspection-feedback needs it; the
   dormant `execute.ts` has the *shape* via the runs store but nobody runs it).
4. **Stages are not addressable.** Because each stage is an inline `await` in a
   700-line handler, orchestrator-tools cannot yet carve out
   `plan` / `generate keyframe` / `generate clip` / `assemble` / `critique` as
   independent, self-validating tools (Principle 7). The engine must expose them
   as discrete steps first.

## Target design

### The one engine

Introduce a single staged engine module (proposed `src/lib/engine/` — exact
location coordinated with store-consolidation) whose core is an ordered list of
**discrete stage functions** over a shared, serializable context:

```
brief_intake → creative_plan → (character/anchor) → asset_generation (per-beat
  keyframe + clip + inline review) → audio_generation → timeline_assembly →
  quality_review → ready
```

Key properties:

- **Stages are pure-ish, individually-callable units** taking
  `(EngineContext, StageInput) → StageOutput`, not inlined awaits. This is the
  seam orchestrator-tools later promotes to agent tools, and the natural place
  each stage validates its preconditions and returns structured failures
  (Principle 7). For P1 the engine drives them in the existing default order;
  agent-driven ordering is a later phase.
- **One set of helpers.** Promote the *richer* oneshot helpers to the engine and
  delete the execute.ts copies: one `resolveVideoProviders` (the body-aware
  `config.ts` version), one `videoSizeForAspect` (**resolving the 1:1 bug to a
  correct square size in one place**), one `clampSeconds`
  (`normalizeOpenAIVideoSeconds`), one `beatPrompt` (the plan+anchors version),
  one `generateBeatClip` (character/keyframe-capable, from
  `media-generation.ts`), one each of `newId`, `isQuotaError`,
  `optionalStep`, `attachVideoReview`, `reviewClipIfPossible`,
  `promptWithVisualFeedback`, `generateBeatClipWithReview`.
- **One run/stage model.** The engine reads/writes the single `GenerationRun`
  chosen by store-consolidation; the duplicate `src/lib/runs/types.ts` model is
  retired with its module.
- **An emit seam, not baked-in I/O.** The engine takes injected callbacks:
  `onStageStart/onStageComplete/onStageFail(stage, message, percent)` and
  `onArtifact(artifact)` (fired the moment a keyframe/clip/soundtrack/timeline
  is produced — the per-beat `savePartialProject` and `setStageMessage` calls
  become emissions). inspection-feedback subscribes for progress/gates;
  asset-pool subscribes to land artifacts in the immutable pool. The engine
  itself does not know whether it is being polled or streamed.
- **Optional gates between stages.** Before starting a gated stage the engine
  checks the run's `reviewGates` and pauses (autonomous-by-default, Principle 2);
  the gate *policy* and resume mechanics are inspection-feedback's, the engine
  only provides the pause/resume hook.

### How sync and async wrap the one engine

- **Synchronous entry (the thin one-shot call).** `/api/oneshot` becomes a thin
  adapter: build `EngineContext` from the request, create a run via the shared
  store, call `runEngine(ctx, { onStage, onArtifact })` with callbacks that
  (optionally) stream NDJSON/SSE progress to the caller, `await` to completion,
  return the final `project`. Same single-request UX
  (`docs/streaming-generation-plan.md` Workstream C), now backed by the engine.
  Editor.tsx / PromptComposer.tsx keep calling the same endpoint.
- **Async / background run (the trunk).** A worker entry — the real replacement
  for the dead `executeRun` — pulls a queued run and calls the **same**
  `runEngine` with callbacks that persist stage transitions + artifacts to the
  run store. This is what the v1 generation-runs polling API has been waiting on
  ("scope PR 3"); wiring the engine here turns that surface from a stub into a
  live async pipeline.
- Both wrappers differ only in their callbacks and lifecycle (await vs
  fire-and-forget + poll). The generation logic exists exactly once.

## Work breakdown (ordered, PR-sized)

> Each PR is independently shippable and behavior-preserving until the cutover
> PR. Effort: S ≈ <½ day, M ≈ 1 day, L ≈ 2+ days.

1. **PR1 — Extract shared engine helpers (no behavior change). [M]**
   Move the canonical (oneshot) `resolveVideoProviders`, `videoSizeForAspect`,
   `clampSeconds`, `beatPrompt`, `newId`, `isQuotaError`, `optionalStep`,
   `generateBeatClip`, `attachVideoReview`, `reviewClipIfPossible`,
   `promptWithVisualFeedback`, `generateBeatClipWithReview` into
   `src/lib/engine/` (or agreed location). Re-point `/api/oneshot/route.ts` at
   them. **Fix the 1:1 size to a correct square in the single helper.** Delete
   nothing yet.

2. **PR2 — Define the stage interface + `EngineContext` + emit callbacks. [M]**
   Introduce `Stage = (ctx, input) => Promise<output>`, the serializable
   `EngineContext`, and the `onStage*` / `onArtifact` callback types. No stages
   migrated yet; just the contracts (lets orchestrator-tools and
   inspection-feedback build against a stable seam).

3. **PR3 — Carve the live pipeline into stage functions behind the engine. [L]**
   Refactor `route.ts`'s inlined steps into engine stages
   (`planStage`, `planCritiqueStage`, `characterStage`, `assetGenerationStage`,
   `audioStage`, `assembleStage`, `critiqueStage`), preserving exact current
   behavior including resume + partial-save (now via `onArtifact`). `/api/oneshot`
   becomes the thin sync wrapper calling `runEngine`. Behavior-preserving.

4. **PR4 — Retire the dormant twin. [S]**
   Delete `src/lib/runs/execute.ts`, `src/lib/runs/store.ts`,
   `src/lib/runs/types.ts` (orphaned; no callers). Verify no imports break
   (already none outside the dir). Removes the drift source permanently.

5. **PR5 — Async run wrapper on the engine. [M]**
   Add a background-run entry that calls `runEngine` with persistence callbacks
   into the single run store (store-consolidation's model). Wire it behind the
   v1 generation-runs create route so that polling surface drives real
   generation. Depends on store-consolidation having landed the one run model.

6. **PR6 — Stage emit → inspection-feedback + asset-pool sinks. [M]**
   Implement the concrete `onArtifact` sink (artifacts land in the project pool)
   and `onStage*` sink (progress/gates). Largely integration glue; the bulk is
   owned by the sibling workstreams — this PR is the engine-side wiring.

## Dependencies & sequencing

- **PR1 → PR2 → PR3 → PR4** are internal to this lane and can land back-to-back;
  PR1 alone already kills the 1:1 bug and the worst drift.
- **PR4** (delete dead code) can land any time after PR1 (it is independent of
  the refactor; the code is unreferenced today). Sequenced after PR3 only to
  avoid churn while the helpers are in flux.
- **PR5 depends on store-consolidation** landing the single `GenerationRun`
  model (otherwise this PR would re-entrench a second model). Until then, the
  async wrapper can target the v1 model as an interim, but coordinate to avoid
  rework.
- **PR2's contracts unblock orchestrator-tools and inspection-feedback** to
  build in parallel; **PR6 depends on asset-pool** providing the pool sink and
  **inspection-feedback** providing the progress/gate sink.
- This lane does **not** block on provenance-graph or composition; the engine
  emits artifacts and they attach edges/composites downstream.

## Risks & open questions

- **Which `GenerationRun` survives?** Out of this lane (store-consolidation) but
  blocking for PR5. If it slips, PR5 either waits or temporarily targets
  `src/lib/v1/types.ts`'s model — risk of re-doing the wrapper. **Open:** confirm
  with store-consolidation before PR5.
- **Correct 1:1 size.** Neither current value is clearly right for the live
  product (`1280x720` is not square; `1024x1024` is square but may not match a
  provider's supported set). **Open:** confirm the provider-supported square
  size to bake into the single helper (PR1).
- **Behavior parity during PR3.** The live pipeline has subtle, valuable details
  (resume via `resumableClipsForGoal`, quota-fallback mid-loop at
  `route.ts:354`, inline review-regenerate, parallel soundtrack). Carving into
  stages must preserve all of them; risk of regression. Mitigation: PR3 is pure
  refactor with golden-output comparison before the wrapper cutover.
- **`maxDuration = 800` and serverless.** The sync wrapper still runs
  multi-minute work in-request; the async wrapper is the durable answer. This
  lane keeps the sync path working but the long-term home is the background run
  (noted in `docs/streaming-generation-plan.md` Workstream E).
- **Stage granularity vs orchestrator-tools.** The stage boundaries chosen in
  PR2/PR3 become the eventual tool boundaries. **Open:** align the stage split
  with orchestrator-tools' intended tool surface (`docs/NORTH_STAR.md` §6) so we
  don't re-split later.
- **Three run surfaces today.** Fully retiring `src/lib/runs/` (PR4) is safe, but
  the v1 generation-runs surface and the oneshot path must converge on one
  engine + one model without breaking the live runs page
  (`src/app/projects/[projectId]/runs/[runId]/page.tsx`). Coordinate the cutover
  with store-consolidation.
