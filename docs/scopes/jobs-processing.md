# Jobs And Processing Scope

## Objective

Move long-running work out of synchronous request handlers so upload ingest,
media analysis, generation, revision, and export are reliable, retryable, and
observable.

## Job Types

- `asset_ingest`: validate media, extract metadata, create thumbnails.
- `asset_analysis`: optional transcript, scene detection, vision tags, quality
  scoring, embeddings.
- `generation`: plan beats, select clips, critique, create timeline variants.
- `revision`: apply conversational edits to the structured timeline and produce
  a new validated sibling timeline cut.
- `export`: render a timeline to an artifact.

## Job States

- `queued`
- `running`
- `succeeded`
- `failed`
- `canceled`

Each job should include progress metadata where practical:

```ts
interface JobProgress {
  currentStep?: string;
  percent?: number;
  message?: string;
}
```

## Worker Requirements

- Jobs are idempotent or guarded by idempotency keys.
- Workers claim jobs atomically.
- Failed jobs capture typed failure codes and redacted diagnostics.
- Retry policies distinguish transient failures from invalid input.
- Render jobs run in an environment with a compatible browser and media codecs.
- Job logs include request IDs, project IDs, job IDs, and asset/timeline IDs.

## V1 Execution Model

For v1, jobs run locally inside the Express API process. This keeps development
and operation simple while the app is still early.

- Job creation endpoints persist a JSON job record and return `202 Accepted`.
- The API process can execute the job immediately after creation or through a
  lightweight in-process queue.
- Job state is persisted under the local `.local/dev-db/jobs/` directory in
  `AUTH_MODE=local`.
- Generation and export should still be modeled as jobs even when execution is
  local, so the API contract does not change if a separate worker is introduced
  later.
- Revision should also be modeled as a job. V1 revisions should restitch from
  copied source assets using the updated structured timeline rather than trying
  to edit rendered media in place.
- Successful revision jobs should create a sibling `timelineId` and then enqueue
  an export job for that new timeline.
- A separate worker process is explicitly deferred until adoption or workload
  requires it.

## UI Requirements

- Show progress for uploads, generation, revision, and export.
- Allow canceling queued or running jobs where supported.
- Allow retrying failed jobs when the error is retryable.
- Keep the last successful project state visible while new jobs run.

## API Requirements

- Job creation endpoints return `202 Accepted` and a job object.
- Polling endpoints return current state and result pointers.
- Webhooks are out of scope for v1; clients poll job status.
- Terminal job states are immutable.

## Acceptance Criteria

- A generation request does not time out even if model calls take longer than a
  normal HTTP request.
- V1 can execute jobs locally in the API process while preserving the same job
  polling API that a future worker process would use.
- A render failure does not corrupt the timeline or delete previous artifacts.
- A revision job creates a new validated sibling timeline, preserves the previous
  valid cut, and auto-enqueues an export.
- A client can recover from network loss by polling a known job ID.
- Operators can diagnose failed jobs from logs without exposing customer secrets.
