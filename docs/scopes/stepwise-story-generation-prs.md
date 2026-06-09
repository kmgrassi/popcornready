# Stepwise, human-in-the-loop story generation — scope & parallel PR plan

## Goal

Let a user drive a generation **one step at a time from the dashboard**, instead of
one continuous auto-loop:

> Give a prompt → it creates the story → I review it and **type feedback** → I click a
> button → it regenerates that step with my feedback **or** advances to the next step.

## Current state (what exists vs. what's missing)

The "review gate" scaffolding is half-built. What already works:

- **Gate config at creation** — `NewProjectPage.tsx` lets the user tick which stages are
  review gates (`reviewGates` over `GATEABLE_GENERATION_STAGE_TYPES`), passed to
  `POST …/generation-entrypoints/prompt` → `createRunWithSeedStages` seeds stages with
  `isReviewGate` (`apps/api/src/lib/v1/generation-runs/payload.ts:145-187`).
- **Pause** — when a gated stage succeeds, `RunReviewGatePaused` halts the job and the run
  holds with `reviewGate: {stageType, stageId, state:"awaiting_review"}`
  (`generation.ts` + `progress-emitter.ts` + `payload.ts pauseAfterStageIfReviewGate`).
- **Review-gate UI** — `components/progress/ProgressView.tsx:205-276` shows the gate card
  with **Approve & continue / Reject / regenerate / Cancel**; `RunProgressPage.tsx` polls
  and calls `approve`/`reject`/`cancel`.
- **Endpoints** — `routes/v1/generation-runs.ts`: `POST …/approve`, `…/reject` (`{stageType?, note?}`), `…/cancel`, `GET …/:runId`.
- **Data model** — `generation_runs(review_gates, review_gate, current_stage_type, status)`,
  `generation_stages(is_review_gate, reviewed_at, status)`, `generation_stage_artifacts`.

**The three real gaps:**

1. **Resume doesn't execute.** `runGenerationJob` is invoked in exactly one place — the
   create entrypoint (`routes/v1/generation-entrypoints.ts:294`). There is **no worker**, and
   `approve`/`reject` only mutate DB state (`generation-runs.ts:86-120`). Nothing re-runs the
   job, so after "Approve & continue" the next stage is `queued` but never executes.
2. **The engine isn't resumable.** `runGenerationJob` (`generation.ts:195+`) is a linear
   function; `beginStage` (`progress-emitter.ts:220`) does **not** skip succeeded stages and the
   stage code unconditionally re-calls `planEdit`/storyboard/`selectClips`/`critique`. Naively
   re-invoking it redoes **every** prior stage (incl. expensive media), not "resume from the gate."
3. **Feedback never reaches the model.** `rejectReviewGate` (`payload.ts:253-322`) writes the
   `note` only to the stage/run **`message`** (display text); `runGenerationJob`/`planEdit`
   never read it. And `approve` carries no note at all.

## Target architecture

- `runGenerationJob` becomes **resumable**: skip already-`succeeded` stages and rebuild their
  outputs from persisted artifacts; only compute `queued` stages; pause at the next gate.
- The higher-level **orchestrator agent** is the target controller for re-entry:
  it periodically resumes from durable run/tool state, decides which registered
  stage/tool to call next, and can re-enter any stage when user feedback,
  precondition failures, or provenance invalidation make that the right move.
- `approve`/`reject` **re-invoke** the job (via a resume helper that builds an execution context
  for an *existing* run) so the next/regenerated stage actually runs.
- A per-run **`review_feedback`** field carries the user's note into the regenerated stage's
  agent prompt (`planEdit` first; pattern extends to other stages).
- Frontend: a **feedback textarea** on the gate card, and a **step-by-step toggle** that gates
  every stage.

---

## Shared contracts (agree on these before parallel work starts)

These are the seams between workstreams; build against them as stubs.

- **API**
  - `POST /projects/:projectId/generation-runs/:runId/approve` — body `{ note?: string }` (new
    optional). Side effect: clears the gate, advances `currentStageType`, **persists a non-empty
    `note` as run `review_feedback`** (forward guidance the *next* stage consumes — symmetric with
    reject so a note typed on "Approve & continue" is never silently dropped), **and kicks resume**.
  - `POST …/:runId/reject` — body `{ stageType?, note?: string }` (already typed). Side effect:
    resets the gated stage to `queued`, **persists `note` as run `review_feedback`**, **and kicks resume**.
  - **Feedback is single-channel and symmetric:** both paths write the same `review_feedback`
    field; the difference is only *which* stage runs next (reject re-runs the gated stage, approve
    advances). Either path with an empty/absent note leaves `review_feedback` untouched.
  - Both return the full run payload. Resume runs forward until the next gate/terminal state
    (mirror the entrypoint's await-then-202; frontend keeps polling `GET …/:runId`).
- **Data**: `generation_runs.review_feedback text` (nullable). `GenerationRun.reviewFeedback?: string | null`
  in `packages/shared/src/v1/types.ts`.
- **Agent**: `planEdit(input)` gains `feedback?: string` (`apps/api/src/lib/agent/index.ts:97`).
- **Resumability invariant**: re-invoking `runGenerationJob` for a run whose earlier stages are
  `succeeded` must NOT recompute them — it loads their output from `generation_stage_artifacts`
  (or stored assets) and runs only `queued` stages.
- **Durable tool-call boundary**: an LLM tool call is a request for the server to
  perform and persist work, not an in-memory return value that can be
  daisy-chained into the next function. The tool handler must write the relevant
  database rows / `generation_stage_artifacts` / generated assets first, mark the
  invocation or stage complete, and only then may the next stage/model turn read
  that persisted state. If the tool returns `waiting_for_job` or
  `waiting_for_approval`, the run stays `waiting` and no next model turn starts
  until the awaited job/gate completes.
- **Controller split**: the first implementation may keep a deterministic fixed
  stage order, but only as a thin controller over the same durable stage/tool
  contracts. The target controller is the orchestrator tool loop scoped in
  `docs/scopes/structured-outputs-to-tool-calls.md`: one model turn chooses one
  server-owned tool, the handler persists output or records a wait, and the next
  turn reads the persisted result/error. Fixed-engine resume and orchestrator
  re-entry must share the same artifact loaders so they do not diverge.

---

## Pipeline movement model

There are two phases of this migration:

### Phase 1 — Fixed controller, durable stage handoff

The dashboard can keep starting a normal `generation_run`, and the server can
keep the current default stage order. The behavior changes at every boundary:

1. A stage starts by loading its required inputs from storage (`briefVersionId`,
   prior `generation_stage_artifacts`, ready asset IDs, active selections).
2. The stage runs its leaf model/provider work.
3. The stage persists its canonical output and links it to the stage:
   - `creative_plan` -> `EditPlan` artifact
   - `storyboard` -> storyboard asset IDs plus a stage artifact snapshot
   - `timeline_assembly` -> `Timeline` / `EditGraph` artifact or row IDs
   - `quality_review` -> critic report, patches, and revised timeline pointer
4. Only after persistence succeeds does the stage become `succeeded`.
5. The next stage loads by ID from persisted state. It must not consume a hidden
   local variable from the previous stage.

This makes approve/reject resume and browser refresh recovery use the same path:
re-enter the run, inspect stage statuses, skip succeeded stages, and load the
latest canonical output needed for the next queued stage.

### Phase 2 — Orchestrator controller, same durable tools

Once the durable stage contracts exist, replace the fixed controller with the
orchestrator loop already scoped in `structured-outputs-to-tool-calls.md` and
partially implemented under `apps/api/src/lib/orchestrator/`.

The loop is:

```text
load run/project state
  -> orchestrator model chooses one registered server tool/stage
  -> tool validates preconditions and persists output, or records waiting state
  -> run waits for job/approval when needed
  -> next orchestrator turn reads durable result/error and chooses the next tool
```

The orchestrator, not the hardcoded stage order, decides whether to proceed,
pause for review, rerun `creative_plan`, regenerate only a storyboard/keyframe,
retry media generation, reassemble the timeline, or stop. User feedback,
precondition errors, and provenance/staleness signals are inputs to that choice.

The frontend still polls `GET …/generation-runs/:runId`; it observes the run,
stage, item, and artifact pointers. It does **not** decide whether rows are ready
or call the next step. The server-side controller (fixed in Phase 1,
orchestrator in Phase 2) advances only after the relevant persisted outputs are
present.

## Workstreams (parallelizable)

### A — Resumable engine *(foundation; highest risk)*
Make `runGenerationJob` skip-and-load instead of recompute.
- **Files:** `apps/api/src/lib/v1/generation.ts`, a new `loadStageOutput(runId, stageType)` helper
  reading `generation_stage_artifacts` (plan persisted as `kind:"timeline"`, timeline likewise;
  assets via stage items), `generation-runs/store.ts` (read stage statuses).
- **Work:** at each stage block, branch `stage.status === "succeeded" ? loadOutput() : compute()`;
  load the run's stages at job start; ensure `briefVersion`/`storyContext` are reloaded, not
  recomputed-with-side-effects. Sub-tasks split cleanly per stage (creative_plan, storyboard,
  timeline_assembly, quality_review, …) — those can be done by different people.
- **Done when:** a run gated at stage N, when re-invoked, skips stages < N (asserted: no extra
  `planEdit`/provider calls) and resumes at N. Unit tests with injected `deps` counting calls.

### B — Resume wiring (API) *(depends on A)*
Re-invoke the job from approve/reject.
- **Files:** `routes/v1/generation-runs.ts` (approve/reject handlers), a new
  `resumeGenerationRun(runId)` (refactor `lib/v1/generation/run-execution.ts` to split
  "create run" from "build execution context for an existing `runId`"; resolve the job id from
  the run — stage `jobIds`/`attachJob`).
- **Work:** after `approveReviewGate`/`rejectReviewGate`, call `resumeGenerationRun` (await to the
  next pause/terminal, return 202). Guard against double-dispatch (job must be `queued`).
- **Done when:** clicking Approve runs the next stage to its gate; clicking Reject regenerates the
  gated stage; live test on a `creative_plan` gate (cheap, LLM-only).

### C — Feedback threading *(mostly parallel; coordinates with A on generation.ts)*
Carry the note into the model.
- **Files:** new migration `supabase/migrations/<ts>_run_review_feedback.sql`
  (`alter table public.generation_runs add column review_feedback text;` — additive, applies via
  `supabase db push`, no reset), `packages/shared/src/v1/types.ts` (`reviewFeedback`),
  `generation-runs/store.ts` (column ↔ field mapping), `payload.ts` — store a non-empty note in
  **both** `rejectReviewGate` **and** `approveReviewGate` (same `review_feedback` field, so a note
  typed on approve isn't dropped),
  `generation.ts` creative_plan (read `run.reviewFeedback` → pass to `planEdit`, then clear),
  `agent/index.ts planEdit` (accept `feedback`, add a "User feedback on the previous attempt: …"
  line to the prompt).
- **Done when:** rejecting `creative_plan` with a note produces a visibly different plan that
  reflects the note; an approve note biases the next stage the same way; `review_feedback` is
  cleared after consumption.

### D — Feedback box UI *(independent frontend)*
- **Files:** `components/progress/ProgressView.tsx` (add a `<textarea>` to the gate card; change
  `reviewActions.onReject`/`onApprove` to take the typed note), `routes/RunProgressPage.tsx`
  (hold the note in state; pass it to `runAction("reject"|"approve")` — replaces the hardcoded
  `"Regenerate from review feedback."` at `:117`), `lib/api-client.ts` (`updateGenerationRun`
  already sends `note` on reject; add it to approve).
- **Done when:** the gate card has a feedback field; reject/approve send the typed note. Can merge
  ahead of C (note is accepted but only takes effect once C lands).

### E — Step-by-step toggle UI *(independent frontend)*
- **Files:** `routes/NewProjectPage.tsx` — add a "Step through every stage" switch that sets
  `reviewGates = [...GATEABLE_GENERATION_STAGE_TYPES]` (and clears it when off); keep the existing
  per-stage checkboxes for fine control.
- **Done when:** the toggle gates all stages; default stays auto-run (off).

### F — Tests & verification *(after A–C land)*
- Unit: resumability skip (A), reject-note-in-prompt (C), approve/reject re-invoke (B).
- Live: gate `creative_plan` → reject with feedback → plan changes → approve → storyboard begins.

### G — Orchestrator controller bridge *(after durable handoff exists)*
- **Files:** `apps/api/src/lib/orchestrator/*`,
  `apps/api/src/lib/v1/generation/story-flow-tools.ts`,
  `apps/api/src/lib/v1/generation/run-execution.ts`, route wiring for the run
  driver feature flag.
- **Work:** expose the durable stage contracts as registered orchestrator tools;
  make the run driver wake on job/gate completion; feed tool results/errors,
  review feedback, and candidate stale/provenance signals into the next model
  turn; keep one-tool-per-turn for recoverability.
- **Done when:** with the orchestrator flag enabled, a run can enter at
  `creative_plan`, pause for approval, resume into `storyboard`, reject and
  re-enter the rejected stage, and continue without relying on in-memory outputs.

---

## Dependency graph & merge order

```
A (resumable engine) ──► B (resume wiring) ──┐
C (feedback threading) ──────────────────────┼─► F (tests/verify)
D (feedback box UI) ─────────── independent ──┘
E (toggle UI) ─────────────────── independent
A+B+C durable handoff ────────────────────────► G (orchestrator controller bridge)
```

- **Start immediately in parallel:** A, C (different stage concerns), D, E.
- **B** needs A's resume helper + skip logic.
- **G** should not start until A has made stage outputs durable. Otherwise the
  orchestrator would still be choosing tools whose results are secretly chained
  through process memory.
- **Merge hotspots (coordinate / sequence):** `generation.ts` is edited by **A and C** — land A's
  per-stage structure first or have C add only the small read-feedback hook at `creative_plan`;
  `payload.ts` is touched by **B and C** (reject) — keep B's change to the route, C's to
  `rejectReviewGate`. Per `AGENTS.md`, keep each PR to distinct files where possible.

## Risks / decisions

- **Resumability correctness (A)** is the main risk: downstream stages depend on prior outputs, so
  "load from artifact" must reconstruct the same in-memory objects (`EditPlan`, timeline, asset
  lists). Mitigate with the call-counting unit tests above.
- **No direct daisy-chaining of tool outputs:** if future work swaps fixed stage
  calls for model-selected server tools, the next step must wait for the tool's
  persisted side effects rather than consuming the raw tool-call arguments or a
  transient handler return. The existing orchestrator wait states
  (`waiting_for_job`, `waiting_for_approval`) are the reference behavior.
- **Execution duration:** resume awaits forward to the next gate; a non-gated media stage can be
  slow. Keep the await-to-next-pause + 202 + poll model (matches the entrypoint). Fire-and-forget
  is an alternative if long media stages make the request time out.
- **Scope dial:** shipping **C+D+E + B for the cheap early stages** (gate only `creative_plan`/
  `storyboard`, where re-running is LLM-only) delivers the story-iteration loop without A's full
  media-stage resumability — a viable first milestone if A slips.
- **Controller migration:** the orchestrator tool-loop (`lib/orchestrator/`,
  `story-flow-tools.ts`) is inherently one-step-per-turn with `request_approval`
  gates but is feature-flagged off (`POPCORN_STORY_FLOW_TOOL_LOOP`) and not
  wired to the dashboard. Treat the fixed-engine resumability work as the bridge:
  it establishes durable stage contracts that the orchestrator controller will
  later call. Do not build a second set of tool contracts for the orchestrator.

## Verification (end-to-end)

1. `/projects/new` → enable the **step-by-step** toggle (E) → start a prompt run.
2. Run pauses at `creative_plan`; review the story, type feedback (D), click **Regenerate** →
   plan changes per feedback (C); click **Approve & continue** → next stage runs (A+B).
3. Confirm skipped stages don't re-call providers (A unit test) and `review_feedback` clears (C).
