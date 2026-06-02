# North Star — Inspection, Gates & Feedback Loop

> **Goal (one line):** make every artifact visible the instant it pops, let the
> user pause/approve/regenerate any stage, browse the idle asset pool and
> re-point a slot's active selection, and close the OODA loop so approvals,
> edits, and critic findings improve future prompts.

## Status

- **Phase:** P3 in the North Star phasing (`docs/NORTH_STAR.md:230`), depends on
  P1 (one engine + provenance graph) and P2 (orchestrator). Design only — no code
  in this doc.
- **Scope owner:** `inspection-feedback` workstream.
- **Surprising finding up front:** most of the surfacing/gate machinery is
  **already built but dead-wired.** A full v1 generation-run stack (store, stage
  items, gate logic, a pausing progress emitter, approve/reject/retry routes, and
  a `ProgressView` with gate UX) exists, but **nothing executes it.** The live
  landing page generates through the synchronous `/api/oneshot` route, which
  blocks for the whole generation, emits no live artifacts, and ignores gates. So
  a large part of this lane is **connecting existing pieces**, not building new
  ones.

### Sibling cross-references (stay in lane; do not redo)

- **unified-engine** — owns collapsing `/api/oneshot` + `src/lib/runs/execute.ts`
  + the dormant v1 run pipeline into one engine that *emits* artifacts and *pauses*
  at gates. This lane **consumes** those emissions; it does not own the engine.
- **asset-pool** — owns the project-scoped immutable pool + per-slot active
  selection model (`docs/NORTH_STAR.md:182`). This lane builds the **dashboard
  that browses that pool and the UI that flips the active pointer**; it does not
  define the pool schema.
- **orchestrator-tools** — owns the propose-before-spend tool surface
  (`docs/NORTH_STAR.md:209`). Gate "regenerate" actions and OODA "Act" steps
  **call** those tools; this lane does not define them.
- **provenance-graph** — supplies the `beatId`/`anchorIds`/fingerprint edges that
  let a gate's "regenerate" target the right node and let feedback attach to a
  specific artifact.
- **store-consolidation** — collapses the three drifted run stores (below) so the
  dashboard and gates read one source of truth.
- Related existing scopes that this doc *unifies and supersedes the framing of*:
  `docs/scopes/generation-review-checkpoints.md` (gate config + approve/reject),
  `docs/scopes/generation-progress-ui.md` (stage rail + asset cards),
  `docs/scopes/video-snapshot-review.md` (per-clip review),
  `docs/scopes/dashboard-ui.md` (cross-project browse),
  `docs/scopes/ooda-feedback-loop.md` (Observe/Orient/Decide/Act).

## North Star alignment

This lane is the user-facing surface of three North Star principles:

- **Principle 2 — "Autonomous by default; stops are opt-in"**
  (`docs/NORTH_STAR.md:31`): YOLO stays one click; gates are opt-in pauses at any
  artifact.
- **Principle 5 — "Propose before expensive redo"** (`docs/NORTH_STAR.md:45`):
  the gate's "regenerate" affordance is where the agent proposes a re-run plan
  with a rough cost before spending.
- **Principle 9 — "Nothing is throwaway"** (`docs/NORTH_STAR.md:79`) + the pool /
  active-selection model (`docs/NORTH_STAR.md:182`): the dashboard makes the
  persisted pool *visible and reusable* — "I like image 10, use it here" is a
  re-point, not a regeneration.
- **P3 feedback tie-in** (`docs/NORTH_STAR.md:230`): approvals/edits/critic feed
  back to improve prompts, per `docs/scopes/ooda-feedback-loop.md`.

## Current state (cited)

### A) Three drifted run pipelines; the surfacing-capable one is dormant

1. **Live path — synchronous, opaque.** The landing UI posts to `/api/oneshot`
   (`src/components/PromptComposer.tsx:194`). The comment there is explicit: the
   v1 generation-runs endpoint "only seeds a queued run today (real execution is a
   later scope), so submitting there would leave the run queued forever." It even
   forwards `reviewGates` but notes "the one-shot pipeline does not yet honor
   per-stage review gating" (`src/components/PromptComposer.tsx:190`). The route
   blocks up to `maxDuration = 800` seconds (`src/app/api/oneshot/route.ts:50`)
   and returns the whole project at once — no progressive surfacing.

2. **Message-string run store — dead-wired.** `src/lib/runs/execute.ts` is the
   "async twin of /api/oneshot" but **nothing imports `executeRun`** (verified by
   grep — only its own file references it). It writes progress as **message
   strings only** via `setStageMessage` / `startStage` / `completeStage`
   (`src/lib/runs/store.ts:231`, `:176`, `:196`) and **never creates a stage
   item** — its `GenerationStage.items` array (`src/lib/runs/types.ts:74`) is
   seeded empty (`src/lib/runs/store.ts:86`) and never populated. So "Generated 3
   of 8 clips…" is a string, not eight inspectable cards.

3. **v1 generation-run stack — fully built, never executed.** A second, richer
   model lives under `src/lib/v1/generation-runs/`:
   - Per-asset **stage items** with `assetId`/`artifactId`/`provider`/
     `promptPreview` (`src/lib/v1/types.ts:379`).
   - A **progress emitter** that creates running items, marks them
     succeeded/failed, and **pauses the run at a gate** by throwing
     `RunReviewGatePaused` after a gated stage succeeds
     (`src/lib/v1/generation-runs/progress-emitter.ts:84`, `:136`, `:161`).
   - Full **gate vocabulary**: `GATEABLE_GENERATION_STAGE_TYPES`
     (`src/lib/v1/types.ts:295`), `RunReviewGate` (`:314`),
     `approveReviewGate` / `rejectReviewGate` / `pauseAfterStageIfReviewGate`
     (`src/lib/v1/generation-runs/payload.ts:138`, `:202`, `:174`).
   - **Routes** for approve / reject / retry / cancel
     (`src/app/api/v1/projects/[projectId]/generation-runs/[runId]/approve/route.ts`,
     `.../reject/route.ts`, plus `retry/`, `cancel/`).
   - **Gate-aware UI** already written: `ProgressView` renders the awaiting-review
     banner, the gated stage's items, and approve/reject controls
     (`src/components/progress/ProgressView.tsx:57`, `:163`, `:222`); `StageRail`
     marks the awaiting-review stage (`src/components/progress/StageRail.tsx:50`);
     `StageItemCard` renders per-asset cards
     (`src/components/generation-progress/StageItemCard.tsx`).

   **But:** the create-run route only seeds queued stages — its comment says real
   stage transitions are wired by "scope PR 3" which has not landed
   (`src/app/api/v1/projects/[projectId]/generation-runs/route.ts:13`). And the
   run-progress page renders **fixtures/demo snapshots, not live runs** — its
   header comment: "Until PRs #1–#5 land it renders against fixture snapshots"
   (`src/app/projects/[projectId]/runs/[runId]/page.tsx:13`, using
   `buildDemoRun` from `src/lib/generation-run/fixtures`).

   Net: gates, stage items, and approve/regenerate UX exist end-to-end **except**
   the one thing that drives them — an engine that calls the emitter. That belongs
   to **unified-engine**; this lane defines what it must emit and consumes it.

### B) No dashboard to browse the idle pool or set-active

- Generated clips are persisted on `Project.clips` and referenced by
  `TimelineSegment.clipId` (`src/lib/types.ts`), i.e. today's `Clip[]` pool +
  active-selection-by-reference already exists for clips only.
- There is **no UI** that lists pooled assets *not* currently used by a slot and
  lets a user re-point a slot. `dashboard-ui.md` scopes cross-project browse
  (`/assets` grid) but is **read-only/navigate-only** by its own Non-Goals
  (`docs/scopes/dashboard-ui.md:20-23`); it has no "use this asset here" action.
- The cross-project read endpoints it needs don't exist yet, and it flags that run
  state is split across stores (`docs/scopes/dashboard-ui.md:170-182`) — the same
  drift as (A).

### C) The OODA loop is wide open — feedback never re-enters generation

- **`videoQualityContextForPrompt()` is a static constant** — the whole file is a
  hard-coded string returned verbatim (`src/lib/video-quality-context.ts:1`,
  `:13`), injected into every beat prompt (`src/app/api/oneshot/prompts.ts:53`;
  also `src/lib/runs/execute.ts:90`). It never reflects anything learned.
- **The in-run critic report is stored but never re-read into a prompt.**
  `Project.critic` (`src/lib/types.ts:389`) is written at
  `src/app/api/oneshot/route.ts:477` and only *displayed* in the editor sidebar
  (`src/components/editor/SidebarPanel.tsx:49`). Grep confirms no prompt path
  consumes it.
- **Per-clip visual review feedback is intra-run only.** `reviewGeneratedVideoSnapshots`
  produces a `VideoSnapshotReview` with `recommendedAction` that triggers a
  one-shot regeneration *within the same run* via `promptWithVisualFeedback`
  (`src/lib/runs/execute.ts:211`, `:246`), but the learning evaporates when the
  run ends — nothing aggregates it across runs.
- There is **no `FeedbackEvent` / `FeedbackInsight` / `WorkspacePreference` /
  `PromptConfigVersion`** store; those are entirely aspirational in
  `docs/scopes/ooda-feedback-loop.md:116`.

## Gap vs North Star

| North Star expectation | Today | Gap |
| --- | --- | --- |
| Artifacts visible as they pop (P2 §31) | `/api/oneshot` blocks ~13 min, returns all at once; message strings only | Engine must emit per-asset items live; UI must poll live runs (not fixtures) |
| Pause/approve/regenerate any stage (P2 §31, P5 §45) | Gate stack built but never executed; UI renders demos | Wire the gate path into the real engine; route landing flow through it |
| Browse idle pool, "use image 10 here" (§182) | Pool exists for clips; no browse/re-point UI | Build pool-browse + set-active UI over the asset-pool model |
| Approvals/edits/critic improve future prompts (P3, OODA) | Static constant; critic display-only; per-clip feedback intra-run | Capture → aggregate → propose → inject feedback-derived context |

## Target design

### 1. Artifact surfacing (live, per-asset)

- **Contract this lane owns:** every stage that produces media emits a
  `GenerationStageItem` (`src/lib/v1/types.ts:379`) when work *starts* (status
  `running`, `promptPreview`, `provider`, skeleton card) and updates it to
  `succeeded` with an `assetId`/`artifactId` the instant the asset lands. The
  emitter already supports this (`progress-emitter.ts:84`); **unified-engine** must
  call `startItem`/`succeed` per beat-keyframe, per clip, per audio track instead
  of writing a summary string.
- **UI:** the existing `StageItemCard` + `ProgressView` already render skeleton →
  running → thumbnail/playback states; point the run-progress page at the **live
  payload** (`assemblePayload`, `payload.ts:321`) instead of `buildDemoRun`
  (`runs/[runId]/page.tsx:13`). Reuse the polling client
  (`src/lib/v1/generation-runs/client.ts`).
- **Decision:** retire the message-string `src/lib/runs/store.ts`/`execute.ts`
  pair in favor of the v1 stage-item model (coordinate with store-consolidation);
  do not extend the dead path.

### 2. Gate UX on the unified run

- **Config:** keep the already-built `reviewGates` create-run body
  (`payload.ts:97`) and the `PromptComposer` checkbox UI
  (`src/components/PromptComposer.tsx:294`); default empty = YOLO
  (`generation-review-checkpoints.md:60`). When the landing flow moves off
  `/api/oneshot` onto the run engine, the forwarded `reviewGates` finally take
  effect.
- **Pause/resume:** reuse `RunReviewGatePaused` (`progress-emitter.ts:161`) and
  `approveReviewGate` (`payload.ts:138`). The engine catches the pause and stops
  dispatching; approve resumes at the next stage.
- **Regenerate (the North Star upgrade over plain reject):** `reject` today resets
  the stage to re-run it (`reject/route.ts:14`). Evolve it from "re-run the whole
  stage" toward **"the agent proposes a minimal re-run plan with rough cost"**
  (Principle 5) by delegating to **orchestrator-tools**: a reject at the
  `asset_generation` gate with a note ("beat 3 too dark") should target beat 3's
  node via the **provenance-graph**, not blindly re-run all eight clips. Until
  orchestrator-tools lands, ship stage-level reject as the interim.
- **Per-asset gate actions:** because items carry `assetId` and are individually
  retryable (`GenerationStageItem.retryable`, `types.ts:390`), the gate UI should
  offer **keep / regenerate-this-one** per card, wiring item-level reject. This is
  the natural home for the `VideoSnapshotReview.recommendedAction`
  (`video-snapshot-review.md:35`) — surface it on the card as a suggested action.

### 3. Dashboard: browse the idle pool + set-active

- **Pool browse view:** a project (and later workspace, per `dashboard-ui.md`)
  asset library that lists **all** pooled assets including ones **not currently
  active in any slot**, grouped by kind, each card showing provenance (what beat /
  prompt / model it came from) and its review verdict. This depends on the
  **asset-pool** lane making every asset self-describing with `projectId` + role +
  provenance (`docs/NORTH_STAR.md:194`).
- **Set-active flow ("use image 10 here"):** selecting a pooled asset for a slot
  (a beat keyframe role, a timeline segment, an anchor role) **re-points the
  slot's active selection** — adds nothing, regenerates nothing
  (`docs/NORTH_STAR.md:189`). For clips this is editing `TimelineSegment.clipId`
  today; generalize to the asset-pool's active-selection primitive when it lands.
  This is a **mutating** action the read-only `dashboard-ui.md` explicitly
  excludes, so it is **net-new in this lane** and must layer on top of the pool's
  set-active API.
- **Show "idle vs active":** every card badges whether it currently feeds a slot,
  reinforcing "Not in use ≠ unusable" (`docs/NORTH_STAR.md:189`).

### 4. Feedback-loop closure (OODA)

Concrete, phased plan to turn `videoQualityContextForPrompt()` from a constant
into a learned, project/workspace-scoped, versioned context — without letting raw
feedback mutate production behavior (`ooda-feedback-loop.md:13`).

- **Observe (capture).** Add `FeedbackEvent` capture at three existing seams that
  today drop their signal:
  1. **Gate approvals/rejections** — when a user approves or rejects a gate
     (`approve`/`reject` routes), record it as a `FeedbackEvent` linked to the
     stage/asset and any reject note.
  2. **Set-active edits** — when a user re-points a slot away from the generated
     active asset to a different pooled one, that's an implicit "the generated one
     was wrong" signal worth capturing.
  3. **Critic + per-clip review** — persist `Project.critic`
     (`types.ts:389`) and each `VideoSnapshotReview` as feedback events instead of
     letting them die at run end.
- **Orient/Decide.** Aggregate per-project (and, with repeated evidence, per
  workspace) into `FeedbackInsight`/`FeedbackDecision`
  (`ooda-feedback-loop.md:116`). Prefer narrow scope first.
- **Act (the closure).** Make `videoQualityContextForPrompt()` accept a
  `projectId`/`workspaceId` and return the static base **plus** the
  highest-confidence learned `PromptConfigVersion` additions
  (`ooda-feedback-loop.md:128`). This is **not** a single chokepoint:
  `videoQualityContextForPrompt()` is injected at multiple prompt-assembly
  sites that must each be updated to thread `projectId`/`workspaceId`:
  - the agent module-level `PREAMBLE`, where the result is baked in at import
    time and reused across every agent system prompt
    (`src/lib/agent/index.ts:47`, consumed at `:86`, `:121`, `:171`, `:244`,
    `:286`) — note the constant `PREAMBLE` will have to become a per-call
    builder so scope can be passed in;
  - the composition prompt (`src/lib/agent/composition.ts:57`);
  - the one-shot beat prompt (`src/app/api/oneshot/prompts.ts:53`).
  (`src/lib/runs/execute.ts` previously injected this too, but that async run
  pipeline was deleted in PR #100, so it is intentionally dropped from this
  plan.) Closing the loop therefore means updating every site above plus the
  capture/aggregate plumbing. Global/workspace changes stay gated by human
  approval (`ooda-feedback-loop.md:108`).

## Work breakdown (ordered, PR-sized)

> Effort: S ≈ <1 day, M ≈ 1–3 days, L ≈ ~1 week. Items marked **[blocked]**
> need a sibling lane first.

1. **Point the run-progress page at live runs.** Replace `buildDemoRun` with
   `assemblePayload` + the polling client on
   `projects/[projectId]/runs/[runId]/page.tsx`; keep demo IDs as a dev fallback.
   **S.** (Depends on the engine actually emitting — see #3; can land behind a flag.)
2. **Route the landing flow through the run engine.** Change `PromptComposer.start`
   to POST `/api/v1/.../generation-runs` (with `reviewGates`) and navigate to the
   run page instead of calling `/api/oneshot`. **M.** **[blocked on unified-engine
   executing the run].**
3. **Per-asset emission contract.** Define + document exactly which items each
   stage emits (keyframe per beat, clip per beat, audio track) and assert it with
   a test against the emitter. **S** (the assertions); the *engine* wiring is
   unified-engine's **L**.
4. **Activate the gate path in the live UI.** Verify approve/reject/cancel against
   a real (not demo) paused run; surface the awaiting-review treatment that
   `ProgressView` already renders. **M.**
5. **Per-asset gate actions + review verdict on cards.** Add keep /
   regenerate-this-item controls to `StageItemCard`, wiring item-level reject;
   surface `VideoSnapshotReview.recommendedAction`. **M.**
6. **Propose-before-regenerate.** Replace stage-level reject with an
   orchestrator-proposed minimal re-run plan (cost estimate, target nodes). **M.**
   **[blocked on orchestrator-tools + provenance-graph].**
7. **Pool-browse dashboard view.** Library listing all pooled assets (active +
   idle) with provenance and idle/active badges. **M.** **[blocked on asset-pool
   self-describing assets + a list endpoint].**
8. **Set-active ("use it here") flow.** Mutating UI to re-point a slot's active
   selection to any pooled asset; for clips, edit `TimelineSegment.clipId` as the
   interim. **M.** **[partially blocked on asset-pool set-active API].**
9. **OODA Observe — capture.** `FeedbackEvent` store + capture at gate
   approve/reject, set-active edits, and critic/clip-review persistence. **M.**
10. **OODA Orient/Decide — aggregate + propose.** Per-project/workspace insight +
    decision records, surfaced for review. **L.** **[ties to ooda-feedback-loop.md
    phasing].**
11. **OODA Act — close the loop.** `videoQualityContextForPrompt(scope)` returns
    base + approved learned context (`PromptConfigVersion`); approval-gated for
    workspace/global. **M.**

## Dependencies & sequencing

```
store-consolidation ─┐
unified-engine ──────┼─▶ (1)(2)(3)(4) live surfacing + gates ─▶ (5) per-asset gate
provenance-graph ────┤                                         ─▶ (6) propose-regen ◀─ orchestrator-tools
asset-pool ──────────┴─▶ (7) pool browse ─▶ (8) set-active ────▶ (9) Observe ─▶ (10) Orient/Decide ─▶ (11) Act
```

- **Hard prerequisites:** (2) cannot ship until **unified-engine** executes the v1
  run; (6) needs **provenance-graph** node IDs + **orchestrator-tools**; (7)/(8)
  need **asset-pool**'s self-describing assets and set-active primitive.
- **Can ship independently now:** (1), (3) assertions, (4) against a manually-driven
  run, and (9) Observe capture at the existing approve/reject routes.
- **Sequencing rule:** surfacing (1–5) before propose-regenerate (6); capture (9)
  before any Act (11) — never inject learned context before it's reviewable.

## Risks & open questions

- **Engine ownership boundary.** This lane defines the emit/pause *contract* but
  unified-engine implements the engine. Risk of double-building or gaps if the
  contract isn't agreed first. *Mitigation:* (3) is the contract test, owned here,
  consumed there.
- **Triple-store drift.** Three run stores exist (`src/lib/runs/store.ts`,
  `src/lib/v1/generation-runs/store.ts`, and the `/api/oneshot` direct
  `saveProject` path). Surfacing live data is meaningless until they converge;
  blocked on store-consolidation. *Open:* retire `src/lib/runs/*` outright?
- **Long synchronous request.** `/api/oneshot` holds the request up to 800s
  (`route.ts:50`); moving to the polling engine is required for true live
  surfacing and is a hosting/serverless concern flagged in
  `generation-progress-ui.md:314`.
- **Gate durability.** A paused run is in-process state today; for hosted use it
  must be durable (`generation-review-checkpoints.md:343`). Open: expiry/auto-
  approve policy.
- **Feedback safety.** Letting learned context into prompts risks drift/poisoning;
  Act must stay narrow-scope-first and approval-gated for workspace/global
  (`ooda-feedback-loop.md:108`). *Open:* confidence threshold + rollback.
- **Implicit-signal interpretation.** Is a set-active edit *always* "the generated
  asset was bad," or sometimes just creative preference? Orient must distinguish
  one-off preference from repeated defect (`ooda-feedback-loop.md:55`).
- **Open:** does per-asset regenerate-this-one belong only at a gate, or also
  inline on any completed run (no gate configured)? Leaning: both, since items are
  individually addressable.
