# Generation Progress UI Scope

## Objective

Show users what Popcorn Ready is doing while a video is being generated. A
prompt-only generation can take several minutes, and image or video provider
calls can take tens of minutes. The product should make that wait transparent:
users should see the current stage, completed work, queued work, generated
assets as they appear, and clear recovery paths for failure or refresh.

This scope extends the existing job model in
[Jobs And Processing](./jobs-processing.md). The implementation should reuse
`queued`, `running`, `succeeded`, `failed`, and `canceled` job states, plus
structured progress metadata, instead of creating a second status vocabulary.

## Product Goals

- Return the user to a visible progress screen immediately after they submit an
  idea.
- Show the workflow as stages, not as a single spinner.
- Reveal generated images, clips, narration, timelines, and exports as soon as
  each artifact exists.
- Survive refreshes, tab closes, network loss, and long provider delays.
- Make failures actionable by showing the failed stage, a user-readable message,
  and retry or cancel controls when the backend supports them.
- Preserve the last completed preview or project state while new generation work
  continues.

## Non-Goals

- Perfect ETA prediction. V1 can show elapsed time, rough stage progress, and
  provider wait states without promising an exact finish time.
- WebSockets as the first implementation. V1 should use polling; SSE or
  WebSockets can be added later if polling becomes expensive or too slow.
- A full manual timeline editor. Progress UI should make AI generation visible,
  but Popcorn Ready still does not need a non-AI manual editing surface.
- Hosted object storage migration. V1 can continue to use local development
  storage while keeping asset URLs and IDs compatible with future S3-style
  storage.

## User-Facing Workflow

```text
submit idea
  -> create project and generation run
  -> open progress view immediately
  -> poll run status and stage details
  -> update stage rail, asset grid, audio status, timeline status, and export
  -> show finished video when export succeeds
```

The first useful screen should appear in under two seconds even if no model work
has completed yet.

## Generation Stages

The UI should support these stage types. Individual runs may skip stages when
they are not needed.

| Stage | Purpose | Example User Message |
| --- | --- | --- |
| `brief_intake` | Save the idea, target duration, aspect ratio, and optional config. | Preparing your video brief. |
| `creative_plan` | Generate the script, beat list, visual plan, and asset requirements. | Planning a 60-second explainer. |
| `asset_generation` | Generate stills, clips, screenshots, references, or other visual assets. | Generating visual 3 of 8. |
| `audio_generation` | Generate narration, music, or sound effects. | Creating narration audio. |
| `timeline_assembly` | Convert generated assets into a structured timeline. | Assembling scenes and timing. |
| `quality_review` | Run automated checks for completeness, timing, captions, and obvious quality issues. | Reviewing the generated cut. |
| `export` | Render the final video artifact. | Rendering the final video. |
| `ready` | Show the finished preview and project actions. | Your video is ready. |

Each stage should have an ordered position, status, optional percent, message,
timestamps, and links to related jobs or generated assets.

## Data Model Additions

Add a run-level object so the UI can represent one end-to-end video generation
attempt without requiring the browser to understand every backend job.

```ts
type GenerationRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

interface GenerationRun {
  runId: string;
  projectId: string;
  briefVersionId?: string;
  status: GenerationRunStatus;
  currentStageType?: GenerationStageType;
  progressPercent?: number;
  message?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: GenerationErrorSummary;
}

interface GenerationStage {
  stageId: string;
  runId: string;
  type: GenerationStageType;
  label: string;
  order: number;
  status: GenerationRunStatus;
  progressPercent?: number;
  message?: string;
  startedAt?: string;
  completedAt?: string;
  jobIds: string[];
  artifactIds: string[];
  error?: GenerationErrorSummary;
}
```

Asset-heavy stages should expose child items so the UI can show per-beat cards.

```ts
interface GenerationStageItem {
  itemId: string;
  stageId: string;
  kind: "image" | "video" | "audio" | "caption" | "timeline" | "export";
  label: string;
  status: GenerationRunStatus;
  progressPercent?: number;
  provider?: string;
  promptPreview?: string;
  assetId?: string;
  artifactId?: string;
  retryable?: boolean;
  error?: GenerationErrorSummary;
}
```

For local development, these records can be stored beside the existing local job
records. The shape should remain storage-neutral so a later database migration
does not change the API response.

## API Scope

The browser should be able to create a run, poll it, and recover it after a
refresh.

- `POST /api/v1/projects/:projectId/generation-runs`
  - Creates a run from a brief or prompt-only request.
  - Returns `202 Accepted` with `runId`, `projectId`, and initial stage state.
- `GET /api/v1/projects/:projectId/generation-runs/:runId`
  - Returns the run, stages, stage items, result pointers, and retry/cancel
    affordances.
- `GET /api/v1/projects/:projectId/generation-runs`
  - Lists recent runs so the UI can recover the latest active run.
- `POST /api/v1/projects/:projectId/generation-runs/:runId/cancel`
  - Cancels queued or running work when supported.
- `POST /api/v1/projects/:projectId/generation-runs/:runId/retry`
  - Retries failed retryable stages or items.

Polling behavior:

- Poll every two seconds while the run is active and the tab is visible.
- Back off to five to ten seconds during known long provider waits.
- Pause or slow polling when the document is hidden.
- Poll immediately after create, retry, cancel, or tab focus.
- Use `Cache-Control: no-store` for status responses.

SSE or WebSocket events can be a later PR if polling creates too much load.

## UI Scope

The progress experience should replace the current black-box generation wait
state.

- Submission form returns immediately to a run page or run panel.
- A stage rail shows completed, running, queued, failed, and canceled stages.
- The current stage banner explains what is happening in one short sentence.
- Asset cards show skeletons for queued work, progress for running work, and
  thumbnails or inline previews as artifacts complete.
- The audio stage shows narration/music status and exposes playback once ready.
- The timeline stage shows scenes/beats as structured items when available.
- The export stage shows render progress and swaps to the final video preview
  when the artifact is ready.
- Failed stages show a concise message, diagnostic-safe details, and retry or
  cancel controls when available.
- Reloading with a known `runId` restores the same progress view.

## Proposed PR Sequence

### PR 1: Add Generation Run Scope And Types

Add shared TypeScript types for `GenerationRun`, `GenerationStage`,
`GenerationStageItem`, and `GenerationErrorSummary`. Document how run state maps
to existing job state.

Acceptance criteria:

- Types are available to server and client code.
- Existing job states remain the source of truth.
- No UI behavior changes yet.

### PR 2: Persist Runs And Stages Locally

Add local persistence for generation runs, stages, and stage items under the
same local development storage strategy used by jobs.

Acceptance criteria:

- A run can be created, read, updated, and listed locally.
- Stage updates are timestamped and append-safe enough for refresh recovery.
- Storage code can later be swapped for a database without changing the API
  response shape.

### PR 3: Emit Progress From Generation Jobs

Update composition, asset generation, audio generation, timeline assembly,
quality review, and export code paths to write run and stage progress as work
starts, completes, fails, or retries.

Acceptance criteria:

- Long image/video provider calls mark the correct stage item as running.
- Completed generated assets are linked to their stage items.
- Failed provider calls produce retryable or non-retryable error summaries.
- The run-level `currentStageType`, `progressPercent`, and `message` update
  throughout the workflow.

### PR 4: Add Polling API Endpoints

Expose generation run creation, status, listing, retry, and cancel endpoints
under `/api/v1`.

Acceptance criteria:

- Creating a run returns `202 Accepted` and a pollable `runId`.
- Polling returns run, stages, stage items, and result artifact pointers.
- Status responses are safe to call repeatedly and are not cached.
- Cancel and retry return clear unsupported states when the backend cannot
  perform the action yet.

### PR 5: Start Runs Asynchronously From The Prompt UI

Change the prompt submission path so it creates a run and returns to the UI
without waiting for the full generation to finish.

Acceptance criteria:

- The browser is not held open by a multi-minute request.
- The user lands on a progress screen immediately.
- Existing prompt-only defaults still populate hidden advanced configuration.
- Refreshing the page can recover the active run.

### PR 6: Build The Progress View Shell

Add the user-facing progress layout: stage rail, current status, elapsed time,
and terminal success/failure states.

Acceptance criteria:

- Users can distinguish queued, running, complete, failed, and canceled stages.
- The active stage is obvious on desktop and mobile.
- The UI does not use a single indefinite spinner as the primary status.
- Empty and loading states are polished enough for long waits.

### PR 7: Add Progressive Asset And Audio Cards

Show generated images, clips, audio, captions, and timeline beats as they become
available.

Acceptance criteria:

- Queued items show skeleton cards.
- Running items show provider/status text and optional progress.
- Completed visual items show thumbnails or inline previews.
- Audio items expose playback once available.
- Failed items show concise error state and retry affordance when supported.

### PR 8: Add Retry, Cancel, And Recovery UX

Wire retry and cancel controls into the progress screen, and improve recovery
for refreshed sessions.

Acceptance criteria:

- Retryable failures expose a retry action.
- Cancelable active runs expose a cancel action.
- The latest active run can be recovered from a project page.
- Terminal states leave the final project state visible.

### PR 9: Add Observability And Operator Diagnostics

Add logs and lightweight diagnostics so backend operators can understand slow or
failed runs without exposing secrets.

Acceptance criteria:

- Logs include request ID, project ID, run ID, stage ID, job ID, and provider.
- Provider errors are redacted before being stored or returned to the browser.
- Slow stages can be identified from timestamps.
- Basic metrics can be added later without changing the run API.

## Open Decisions

- Whether `GenerationRun` should be its own top-level resource or a thin
  aggregate over existing jobs.
- Whether prompt submission should create the project first or create project
  and run in one endpoint for the landing-page path.
- How much provider-specific progress can be surfaced for each image and video
  model.
- Whether V1 retry should operate at the whole stage level or individual stage
  item level.
- When to introduce SSE or WebSockets if polling is not responsive enough.

## Risks

- Some providers may not expose granular progress. The UI should still show a
  running item with elapsed time and a clear provider wait message.
- Long-running work inside the API process may not be suitable for hosted
  serverless environments. The run API should be compatible with a later worker
  process.
- Local asset storage is temporary. Stage items should reference assets by ID
  and URL so S3 or another object store can replace local files later.
- Polling every active run can become expensive at scale. Backoff and tab
  visibility controls are required from the first UI implementation.

## End-State Acceptance Criteria

- Starting a one-minute explainer generation immediately shows a progress view.
- A user can tell whether Popcorn Ready is planning, generating visuals,
  generating audio, assembling the timeline, reviewing quality, or exporting.
- Generated images and audio appear progressively instead of only after the
  final render.
- Refreshing the browser during a long provider call recovers the active run.
- A failed generation identifies the failed stage and offers retry when safe.
- Completed videos still appear in the existing examples/gallery experience.
