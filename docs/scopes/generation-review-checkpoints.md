# Generation Review Checkpoints Scope

## Objective

Let a user choose which generation stages to **review before the run
continues**. The run should be able to pause after any selected stage so the
user can inspect that stage's output (the brief, the creative plan, the
generated visuals, the audio, the assembled timeline) and then approve to
continue — or run straight through with no stops ("YOLO, let's go").

This is really one capability with two halves:

1. **Backend:** the run can stop at a checkpoint after any chosen stage and wait
   for the user to approve before the next stage starts.
2. **Frontend:** after the user enters a prompt on the landing page, they get a
   quick configuration step (a popup/page) where they pick which stages to
   review — defaulting to none (run all the way through) — then start the run.

This extends the run/stage model and progress UI defined in
[Generation Progress UI](./generation-progress-ui.md) and the run endpoints in
[API Contract V1](./api-contract-v1.md). It reuses the existing
`GenerationRun` / `GenerationStage` / `GenerationStageItem` model, the ordered
stage seeds, and the existing cancel/retry affordances rather than introducing a
parallel flow.

## Current State

A run is created with eight seeded stages in fixed order
(`src/lib/v1/generation-runs.ts`):

```text
brief_intake → creative_plan → asset_generation → audio_generation
  → timeline_assembly → quality_review → export → ready
```

The run executes straight through; there is no way to stop between stages. There
are already `cancel` and `retry` endpoints and a progress view that polls run,
stages, and stage items. What is missing is a **review checkpoint** (gate)
between stages and a way to configure which stages get one.

## Terminology

- **Review gate** (checkpoint): a marker on a stage meaning "after this stage
  completes, pause the run and wait for the user to approve before starting the
  next stage."
- **Gateable stages:** every stage that produces reviewable output —
  `brief_intake`, `creative_plan`, `asset_generation`, `audio_generation`,
  `timeline_assembly`, `quality_review`, `export`. `ready` is terminal and is
  never gated.
- **Awaiting review:** the run-level state while it is paused at a gate.
- **YOLO run:** a run with no gates selected; it behaves exactly as runs do
  today.

## Default Behavior And The Config Step

When the user enters a prompt, before the run starts they see a short
configuration step listing the gateable stages with a checkbox each:

- **Default: every box unchecked = no gates = "YOLO, let's go."** The primary
  button runs straight through with no stops, preserving today's behavior as the
  one-click happy path.
- Checking a stage's box adds a review gate after it. The user picks any subset
  (or all) of the stages to review.
- A secondary "Review every step" affordance checks all boxes at once.

> Open decision below: whether the checkbox semantics are "check = review this
> step" (recommended, opt-in to friction) or the inverse. The data model is the
> same either way — a set of gated stage types — so the UI copy can flip without
> backend change.

## Data Model Additions

Add the gate configuration and the paused state to the existing run model. No new
status vocabulary for *execution* — job/stage status stays
`queued|running|succeeded|failed|canceled`. The pause is a **run-level lifecycle
state** layered on top.

```ts
// The user's per-run choice of which stages to pause after for review.
type ReviewGateConfig = {
  // Stage types that should pause the run after they complete.
  gatedStages: GenerationStageType[];
};

// Run-level review state, orthogonal to job execution status.
type RunReviewGate = {
  // The stage the run is currently paused after, awaiting approval.
  stageType: GenerationStageType;
  stageId: string;
  state: "awaiting_review";
  enteredAt: string;
};
```

Extensions to existing types:

```ts
interface GenerationRun {
  // ...existing fields...
  reviewGates?: GenerationStageType[];   // configured at creation; empty = YOLO
  reviewGate?: RunReviewGate | null;     // present only while paused at a gate
  // run.status stays a JobStatus; see "Representing the pause" below.
}

interface GenerationStage {
  // ...existing fields...
  isReviewGate?: boolean;                // this stage pauses the run after it completes
  reviewedAt?: string;                   // when the user approved past this gate
}
```

### Representing the pause

While a run is paused at a gate, no underlying job is running and the run is not
finished. Two options (see Open Decisions):

- **Recommended:** keep `run.status` as a `JobStatus` and represent the pause via
  `run.reviewGate` being non-null (the run sits at `running` with execution idle,
  or a derived `awaiting_review` is computed for the UI from `reviewGate`). This
  keeps the execution-status union unchanged, consistent with the
  [Generation Progress UI](./generation-progress-ui.md) rule that run status *is*
  job status.
- **Alternative:** add an explicit `awaiting_review` value to the run-level
  status. Cleaner to read, but introduces a status the job layer does not share.

This scope assumes the recommended option and exposes `reviewGate` so the UI and
API can branch on "is this run waiting on me?" without overloading job status.

## API Scope

All under the existing `/api/v1` run surface from
[Generation Progress UI](./generation-progress-ui.md).

### Configure gates at run creation

Extend the create-run body with the selected gates:

```jsonc
POST /api/v1/projects/:projectId/generation-runs
{
  "prompt": "A 10-year-old boy discovers Popcorn Ready...",
  "reviewGates": ["creative_plan", "asset_generation"]  // empty/omitted = YOLO
}
```

The seeded stages get `isReviewGate: true` for the selected types.

### Read gate state

The existing `GET /api/v1/projects/:projectId/generation-runs/:runId` payload
gains `run.reviewGate` (non-null while awaiting review) and per-stage
`isReviewGate` / `reviewedAt`, so the UI can tell it is paused, at which stage,
and which output to show for approval.

### Approve past a gate

```text
POST /api/v1/projects/:projectId/generation-runs/:runId/approve
```

- Approves the current `reviewGate`, clears it, and resumes the run at the next
  stage.
- Idempotent: approving when not awaiting review (or approving the same gate
  twice) is a no-op success.
- Returns the updated run payload.

### Reject / request changes at a gate (builds on retry)

```text
POST /api/v1/projects/:projectId/generation-runs/:runId/reject
{ "stageType": "asset_generation", "note": "regenerate visuals, too dark" }
```

- Re-runs the gated stage instead of advancing, reusing the existing retry
  machinery. The run stays paused (re-enters `awaiting_review` after the stage
  re-runs).
- Optional in the first pass; can land as a later PR if approve-only ships first.

Cancel remains the existing cancel endpoint and must work while paused.

## Orchestration Behavior

The run executor (the code that advances stages today) changes in one place:
after a stage completes successfully, check whether that stage `isReviewGate`.

- If gated: set `run.reviewGate = { stageType, stageId, state: "awaiting_review",
  enteredAt }`, stop dispatching the next stage, and leave the run idle.
- If not gated (or `ready`): advance to the next stage as today.
- On approve: clear `reviewGate`, mark `stage.reviewedAt`, dispatch the next
  stage.
- Gates on skipped stages are ignored — a run only pauses at gates whose stage
  actually executed.

This keeps the executor's normal path intact; the gate is a guard between stages.

## UI Scope

### Pre-run configuration step

- After prompt submission on the landing/input surface, present a popup or page
  listing the gateable stages with checkboxes and short descriptions ("Plan",
  "Visuals", "Audio", "Timeline", using `GENERATION_STAGE_LABELS`).
- Primary action: **"YOLO, let's go"** (no boxes checked → no gates).
- Selecting boxes adds review gates; a "Review every step" toggle checks all.
- Starting the run posts `reviewGates` and routes to the progress view.

### In-progress review

- The progress view (stage rail, asset cards, etc.) already exists; add an
  **awaiting-review** treatment when `run.reviewGate` is set:
  - The gated stage is marked "Ready for your review" rather than rolling on.
  - The stage's outputs are shown for inspection (plan text, visual cards, audio
    playback, timeline preview — reusing existing stage/item rendering).
  - **Approve & continue** and (if shipped) **Reject / regenerate** controls.
  - Other stages remain visibly queued behind the gate.
- Recovery: reloading a paused run restores the awaiting-review state and
  controls (the gate lives on the run, so refresh just re-reads it).
- Polling can slow/pause while awaiting review since no job is progressing, and
  resumes on approve.

## Proposed PR Sequence

Each PR is independently shippable and leaves the product working. PRs 1–5 make
the backend able to stop and resume; PRs 6–7 add the user-facing config and
review; PR 8 hardens edges.

### PR 1: Gate types and run-model fields

Add `ReviewGateConfig`, `RunReviewGate`, and the `reviewGates` / `reviewGate` /
`isReviewGate` / `reviewedAt` fields to the shared generation-run types. No
behavior change.

Acceptance criteria:

- Types compile and are available to server and client.
- Existing run payloads remain valid (all new fields optional).
- Documented mapping of how the pause is represented relative to job status.

### PR 2: Persist gate config at run creation

Accept `reviewGates` in the create-run body, validate against gateable stage
types, and stamp `isReviewGate` on the matching seeded stages.

Acceptance criteria:

- Creating a run with `reviewGates` marks exactly those stages as gates.
- Omitting/empty `reviewGates` produces a YOLO run identical to today.
- Invalid or non-gateable stage types return `validation_failed`.

### PR 3: Pause the executor at gates

After a stage completes, if it is a gate, set `run.reviewGate`, stop advancing,
and leave the run idle instead of dispatching the next stage.

Acceptance criteria:

- A gated run halts after the gated stage with `reviewGate` populated.
- A YOLO run runs end-to-end exactly as before.
- Gates on skipped stages do not pause the run.

### PR 4: Approve endpoint to resume

Add `POST .../generation-runs/:runId/approve` to clear the current gate, mark the
stage reviewed, and dispatch the next stage.

Acceptance criteria:

- Approving a paused run resumes it at the next stage.
- Approve is idempotent and a no-op when not awaiting review.
- A run with multiple gates pauses again at the next gate after resuming.

### PR 5: Surface gate state in the run payload

Include `reviewGate`, `isReviewGate`, and `reviewedAt` in the run status
response so clients can render the paused state and the right outputs.

Acceptance criteria:

- Status response indicates whether the run is awaiting review and at which stage.
- Stage entries indicate which are gates and whether they were reviewed.
- Status responses stay `no-store` and safe to poll.

### PR 6: Pre-run configuration UI

Add the post-prompt configuration step (popup/page) with stage checkboxes, the
"YOLO, let's go" primary action, and "Review every step", then start the run with
the chosen `reviewGates`.

Acceptance criteria:

- Submitting a prompt leads to the config step before the run starts.
- No selection runs straight through; selections add the right gates.
- The user lands on the progress view after starting.

### PR 7: In-progress review UI

Add the awaiting-review treatment to the progress view: highlight the gated
stage, show its outputs, and add **Approve & continue** (and, if included,
**Reject / regenerate**) controls wired to the approve/reject endpoints.

Acceptance criteria:

- A paused run clearly shows it is waiting on the user and what to review.
- Approving continues the run to the next stage (or next gate).
- Reloading a paused run restores the review state and controls.

### PR 8: Reject/regenerate, recovery, and edge cases

Wire reject-at-gate (reuse retry), ensure cancel works while paused, handle
refresh recovery and polling backoff while awaiting review, and cover
gate-on-skipped-stage and approve-after-cancel races.

Acceptance criteria:

- Rejecting a gate regenerates that stage and re-pauses for review.
- Canceling a paused run cancels cleanly; approving a canceled run is rejected.
- Refresh during a pause recovers the awaiting-review view.
- Polling slows while paused and resumes on approve.

## Open Decisions

- **Checkbox polarity:** "check = review this step" (recommended) vs. "check =
  skip/auto-approve this step." Backend model is identical; UI copy decides.
- **Pause representation:** keep `run.status` as a `JobStatus` and derive
  awaiting-review from `reviewGate` (recommended), vs. add an explicit
  `awaiting_review` run status.
- Whether **reject/regenerate** ships in PR 7 or lands later as PR 8; approve-only
  is enough to be useful.
- Whether to offer **"approve and run the rest with no more stops"** from a gate
  (clear all remaining gates in one action).
- Whether gate selections should be **remembered as a user/workspace default** for
  future runs, or chosen fresh each time.
- Whether an **idle awaiting-review run expires** (auto-approve or auto-cancel
  after N hours) for hosted environments.

## Risks

- Long pauses tie up an in-process run. Like long provider calls in
  [Generation Progress UI](./generation-progress-ui.md), the gate must be
  compatible with a later worker/queue model so a paused run is durable state,
  not a held request.
- Overloading job status with the pause would leak a run-only concept into the
  job layer; keeping the gate orthogonal avoids that.
- A run paused indefinitely consumes storage and (hosted) quota; an expiry policy
  may be needed.
- Adding friction by default would hurt the core flow; YOLO must stay the
  one-click default.

## Acceptance Criteria

- A user can choose, before a run starts, which stages to review — or none.
- A run with gates pauses after each gated stage and shows that stage's output
  for review; approving continues to the next stage or next gate.
- A run with no gates behaves exactly as it does today (one-click YOLO).
- The paused state survives refresh and is readable from the run API without
  overloading job execution status.
- Cancel works while paused; optional reject regenerates a gated stage and
  re-pauses.
