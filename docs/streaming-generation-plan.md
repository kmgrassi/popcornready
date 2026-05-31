# Plan: Streaming, checkpointed generation through the agent pipeline

> Status: Scoping / proposal. No implementation yet — this document defines the
> shape, interfaces, and decisions so the work can be parallelized.

## Goal

Keep the landing-page submit a **single request**, but run it through the
**agent's step machine**, **stream live status** back to the UI, and
**checkpoint each completed step** so a disconnect leaves a resume point —
without clobbering the user's last good video.

## Background

Today there are three coexisting surfaces that all funnel into the same
editorial-agent functions (`planEdit` → `selectClips` → `critique`) but each
re-implements its own orchestration:

- **Landing page** (`Editor.tsx` → `/api/generate`): one blocking POST, awaited
  to completion, static "busy" text, no progress, no durability. Relies on
  `maxDuration = 300`.
- **Agent v1** (`/api/v1/.../generations`): fire-and-forget worker + client
  polling, with real per-step `progress.percent`. Durable-ish job record, but
  in-process (no durable queue).
- **Agent-api** (`/api/v1/.../revisions|exports`): job-shaped but run inline;
  export job is currently a stub that renders nothing.

The reasoning core is genuinely shared; the orchestration is duplicated. This
plan unifies the landing page onto the agent step machine while keeping the
single-request UX, via a streamed response plus step checkpointing.

## Shared contracts (define these first)

These seams let the workstreams proceed in parallel. Lock them before splitting
work.

- **Step enum:** `validating → planning → selecting → critiquing → saving → done`
  (mirrors the existing v1 progress steps).
- **Stream event shape:** `{ step, percent, partialProject?, project?, error? }`,
  newline-delimited JSON (NDJSON) or SSE. Final event carries the full
  `project`; error event carries a message.
- **Draft record shape:**
  `{ requestHash, lastCompletedStep, plan, timeline, updatedAt }`, stored
  separately from the live project.
- **`requestHash`:** stable hash of
  `{ goal, targetLengthSec, style, aspectRatio, storyContext }`. Identical
  submit ⇒ resume; changed brief ⇒ fresh run.

## Workstreams (parallelizable)

### A — Pipeline core (the agent brain, made resumable)

**Owner: backend/agent**

- Extract the plan→select→critique sequence into one shared pipeline function
  that both `/api/generate` and the v1 job worker can call (today the logic is
  duplicated across the route and `runGenerationJob`).
- Add injected callbacks: `onStep(step, percent, partialProject)` and a resume
  input (`fromStep`, `priorPlan`, `priorTimeline`).
- Resume behavior: skip any step at or before `fromStep`, reusing the supplied
  artifacts instead of re-calling the LLM.
- **Contract out:** a function taking the request + optional resume state + an
  `onStep` callback. Depends only on the Step enum.

### B — Draft / checkpoint store

**Owner: backend/persistence**

- Add draft helpers to `src/lib/store.ts`: `saveDraft`,
  `loadMatchingDraft(requestHash)`, `promoteDraft → project`, `clearDraft`.
- **Critical rule:** checkpoints write to the draft slot only. The live
  `project.json` is overwritten **only on success (promote)** — so a
  half-finished run never destroys the prior finished video.
- **Contract out:** the four helpers + the draft record shape. Independent of A;
  buildable and unit-testable in isolation.

### C — Streaming route

**Owner: backend/API**

- Rewrite `/api/generate` to return a streamed response. On request: look up a
  matching draft (B), call the pipeline (A) with an `onStep` that (1) emits a
  stream event and (2) writes a checkpoint to the draft. Promote draft on the
  final step.
- Confirm/set **Node runtime** (route already has `dynamic = "force-dynamic"`,
  `maxDuration = 300` — fine; just ensure not Edge, since streaming + fs need
  Node).
- Wrap in error handling that emits an error event and leaves the draft intact
  for retry.
- **Depends on:** A and B contracts (not their implementations — can stub
  against the contracts).

### D — Frontend stream reader

**Owner: frontend**

- Update `Editor.tsx` `handleGenerate`: keep the single `await fetch`, but read
  the response as a stream. Update the `busy`/progress text per event;
  `setProject` on the final event.
- Add lightweight UI for real progress (step label + percent) replacing the
  static "Planning beats…" string.
- Optional: on mount/refresh, if a matching draft exists, offer
  "resume / discard."
- **Depends on:** the stream event shape only. Buildable against a mock stream
  immediately.

### E — Deployment / durability (do not skip)

**Owner: infra**

- **Finding:** Railway filesystem is **ephemeral and no volume is attached**
  (`railway.toml` has no volume block; `docs/railway-deployment.md` says so
  explicitly, and the app isn't parameterized to `RAILWAY_VOLUME_MOUNT_PATH`).
  `numReplicas` is unset (default 1, which is required — checkpoints are
  instance-local, so multi-replica would break resume).
- **Decision needed:** attach a Railway volume mounted at `data/` and point the
  store at it, **or** accept that checkpointing only protects against in-tab
  disconnects (not instance recycles/redeploys) for now.
- Longer-term the real fix is the Postgres the `store.ts` comment already
  anticipates — out of scope here, but noted.

## Suggested sequencing

1. **First, together:** ratify the four shared contracts above.
2. **Then in parallel:** A, B, D (D against a mock stream).
3. **Integrate:** C wires A+B and replaces the route.
4. **In parallel with all of it:** E (infra decision).

## Open decisions

- **Volume vs. accept-the-limitation** (Workstream E) — affects how much
  durability you actually get.
- **NDJSON vs. SSE** for the stream — both fine; SSE if you want native
  `EventSource`, NDJSON if you want a plain `fetch` reader.
- **v1 job path:** keep it intact (the agent-to-agent poll API still has its
  uses), just have it share Workstream A's pipeline so there's one brain, not
  two.
