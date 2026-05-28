# API Contract V1 Scope

## Objective

Define the first implementable `/api/v1` contract used by both the Vite React UI
and local/hosted agent clients. This doc turns the directional Agent API scope
into concrete route behavior, response envelopes, idempotency rules, pagination,
and open assumptions.

## Contract Principles

- All public routes live under `/api/v1`.
- The browser UI and agent clients use the same resource shapes where practical.
- All mutating routes accept `Idempotency-Key`.
- Long-running operations return jobs and are polled.
- Every response includes stable IDs and schema versions where relevant.
- Errors use a single response shape with stable machine-readable codes.
- `AUTH_MODE=local` bypasses auth and API-key validation, but keeps the same
  request/response contract.

## Response Envelopes

Single resource:

```json
{
  "project": {
    "id": "proj_123",
    "schemaVersion": "project.v1"
  }
}
```

List resource:

```json
{
  "projects": [],
  "pagination": {
    "limit": 50,
    "nextCursor": null
  }
}
```

Error:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "The request body is invalid.",
    "requestId": "req_123",
    "details": {
      "fields": [
        {
          "path": "brief.targetLengthSec",
          "message": "Must be between 1 and 600."
        }
      ]
    }
  }
}
```

## Common Headers

Request:

- `Authorization: Bearer <supabase_access_token>` for browser users in hosted
  environments.
- `Authorization: Bearer <agent_api_key>` for agent clients in hosted
  environments.
- `Idempotency-Key: <client-generated-key>` for mutating routes.

Response:

- `X-Request-Id`
- `X-RateLimit-Limit`
- `X-RateLimit-Remaining`
- `X-RateLimit-Reset`

Rate-limit headers are optional in local mode.

## Idempotency

- Required for `POST` routes that create projects, assets, jobs, exports, API
  keys, or timeline revisions.
- Scoped by actor, workspace, route, and idempotency key.
- Replaying the same request body returns the original response.
- Replaying the same key with a different body returns
  `idempotency_conflict`.
- Idempotency records should expire after a configurable retention period.

Recommended local retention: keep idempotency records in JSON indefinitely until
the `.local/` directory is reset. Hosted retention can be 24-72 hours for v1.

## Pagination

List endpoints use cursor pagination:

- `limit`: default `50`, max `100`.
- `cursor`: opaque string returned from the previous response.
- Sort order defaults to newest first unless the endpoint documents otherwise.

## Core Routes

### Health

- `GET /api/v1/health`
- `GET /api/v1/me`

`/me` returns the resolved actor, workspace memberships, and local-mode status.

### Workspaces

- `POST /api/v1/workspaces`
- `GET /api/v1/workspaces`
- `GET /api/v1/workspaces/:workspaceId`
- `PATCH /api/v1/workspaces/:workspaceId`

Users self-create their first workspace after Supabase sign-up. In
`AUTH_MODE=local`, `dev_workspace` exists automatically.

### Projects

- `POST /api/v1/projects`
- `GET /api/v1/projects`
- `GET /api/v1/projects/:projectId`
- `PATCH /api/v1/projects/:projectId`
- `DELETE /api/v1/projects/:projectId`

Project deletion is soft-delete only in v1. Deleted projects should disappear
from normal list/read calls but remain available for audit, recovery, and
artifact retention policies. Copied source assets and generated artifacts may be
hard-deleted according to retention policy because they are derived from or
managed copies of user-provided files.

Project create request:

```json
{
  "workspaceId": "ws_123",
  "name": "Harper launch teaser",
  "brief": {
    "goal": "Create a punchy 15 second vertical teaser.",
    "targetLengthSec": 15,
    "aspectRatio": "9:16",
    "style": "fast-paced product demo",
    "audience": "clinical operations leaders"
  }
}
```

Project response:

```json
{
  "project": {
    "id": "proj_123",
    "schemaVersion": "project.v1",
    "workspaceId": "ws_123",
    "name": "Harper launch teaser",
    "status": "active",
    "createdAt": "2026-05-28T12:00:00.000Z",
    "updatedAt": "2026-05-28T12:00:00.000Z"
  }
}
```

### Briefs And Context

- `PUT /api/v1/projects/:projectId/brief`
- `GET /api/v1/projects/:projectId/brief`
- `POST /api/v1/projects/:projectId/brief-versions`
- `GET /api/v1/projects/:projectId/brief-versions`

Generation jobs should reference an immutable `briefVersionId`.

### Assets

- `POST /api/v1/projects/:projectId/assets`
- `GET /api/v1/projects/:projectId/assets`
- `GET /api/v1/projects/:projectId/assets/:assetId`
- `PATCH /api/v1/projects/:projectId/assets/:assetId/context`
- `DELETE /api/v1/projects/:projectId/assets/:assetId`

For v1 local development, `POST /assets` may accept multipart upload through the
Express API. Hosted production should support signed upload URLs before large
files are routed through the API server.

Asset source options:

```ts
type AssetSource =
  | { type: "multipart_upload" }
  | { type: "remote_url"; url: string }
  | { type: "local_path"; path: string }; // AUTH_MODE=local only
```

`local_path` is useful for local agents running on the same machine. It must be
disabled in hosted environments. Local path assets should be copied into
`.local/media/uploads/{workspaceId}/{projectId}/` before ingest so subsequent
operations never mutate or depend on the original source file.

### Jobs

- `GET /api/v1/jobs/:jobId`
- `POST /api/v1/jobs/:jobId/cancel`

Job response:

```json
{
  "job": {
    "id": "job_123",
    "schemaVersion": "job.v1",
    "workspaceId": "ws_123",
    "projectId": "proj_123",
    "type": "generation",
    "status": "running",
    "progress": {
      "currentStep": "select_clips",
      "percent": 45
    },
    "result": null,
    "error": null,
    "createdAt": "2026-05-28T12:00:00.000Z",
    "updatedAt": "2026-05-28T12:00:10.000Z"
  }
}
```

### Generation

- `POST /api/v1/projects/:projectId/generations`
- `GET /api/v1/projects/:projectId/generations/:jobId`

Generation request:

```json
{
  "briefVersionId": "briefv_123",
  "assetIds": ["asset_1", "asset_2"],
  "variantCount": 1
}
```

`variantCount` defaults to `1` in v1. Multi-variant generation can be added
later, but the default workflow should create one timeline per generation job.

Generation response:

```json
{
  "job": {
    "id": "job_123",
    "type": "generation",
    "status": "queued",
    "projectId": "proj_123"
  }
}
```

On success, the job result points to created timeline IDs.

### Timelines

- `GET /api/v1/projects/:projectId/timelines`
- `GET /api/v1/projects/:projectId/timelines/:timelineId`
- `PATCH /api/v1/projects/:projectId/timelines/:timelineId`

Direct timeline patching should be reserved for trusted clients and still use
the same validation path as model-generated patches.

### Revisions

- `POST /api/v1/projects/:projectId/timelines/:timelineId/revisions`
- `GET /api/v1/projects/:projectId/timelines/:timelineId/revisions/:jobId`

Revisions are modeled as jobs that produce a new timeline version. V1 should not
attempt destructive in-place media editing. The system should apply the requested
edits to the structured timeline, validate the result, and restitch/render from
the original copied source assets.

Each successful revision creates a sibling `timelineId`, not a version under the
same timeline. This treats every revised cut as a separate timeline that can be
compared, exported, or deleted independently.

Revision request:

```json
{
  "mode": "natural_language",
  "message": "Make the opening faster and use less ambient-mode footage."
}
```

Future mode:

```json
{
  "mode": "patches",
  "patches": []
}
```

Structured patch mode should remain internal or trusted-only for v1. The
external v1 API should expose natural-language revisions first; validated
structured patches can be added later when there is a clear client need.

### Exports

- `POST /api/v1/projects/:projectId/timelines/:timelineId/exports`
- `GET /api/v1/projects/:projectId/exports/:jobId`
- `GET /api/v1/projects/:projectId/artifacts/:artifactId`

Successful revision jobs should automatically enqueue an export for the revised
sibling timeline. Clients can still request explicit exports later.

Export request:

```json
{
  "format": "mp4",
  "quality": "preview"
}
```

Export quality options for v1:

- `preview`
- `standard`

## Error Codes

Minimum v1 error codes:

- `unauthorized`
- `forbidden`
- `not_found`
- `validation_failed`
- `idempotency_conflict`
- `asset_not_ready`
- `asset_invalid`
- `brief_missing`
- `timeline_invalid`
- `job_not_cancelable`
- `job_failed`
- `render_failed`
- `model_output_invalid`
- `rate_limited`
- `internal_error`

## Local Mode Behavior

In `AUTH_MODE=local`:

- `/me` returns `local_dev` actor details.
- `dev_workspace` exists automatically.
- Agent API keys are not required.
- `local_path` asset registration is allowed.
- Local path assets are copied into managed `.local/media/uploads` storage before
  processing.
- Data persists under `.local/`.
- Rate limits may be disabled.

The contract should otherwise match hosted behavior.

## Open Assumptions

- Exact retention window for hard-deleting copied source assets and generated
  artifacts.
- Whether project-level soft deletes should have an operator recovery window
  before metadata is purged.

## V1 Decisions

- Project deletion is soft-delete only.
- Copied source assets and generated artifacts can be hard-deleted according to
  retention policy.
- Local agent `local_path` assets are copied into managed local media storage.
- Generation defaults to one timeline.
- Webhook callbacks are out of scope for v1; clients poll jobs.
- External v1 revisions are natural-language edit requests that generate a new
  validated timeline cut and restitch from copied source assets.
- Successful revisions create sibling timeline IDs and auto-enqueue an export.
- Direct structured timeline patching is deferred for external clients.

## Acceptance Criteria

- The React UI can use this API without private Next.js routes.
- A local agent can create a project, register local files, attach context,
  generate a timeline, revise it, and export without auth.
- A hosted agent can perform the same workflow with a workspace API key.
- Idempotent retries do not duplicate projects, assets, jobs, timelines, or
  artifacts.
- Failed jobs and invalid model output produce typed errors and preserve the
  last valid project state.
