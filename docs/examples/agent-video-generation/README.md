# Agent Video Generation API — Examples

Worked examples for the `/api/v1` agent surface described in
[../../scopes/agent-video-generation-api.md](../../scopes/agent-video-generation-api.md).

> **Status: PR6 scaffolding.** Only the revision, export, and artifact
> endpoints exist today, and the export job emits a `pending_render` artifact
> rather than a finished MP4. The project, asset, generated-asset, composition,
> timeline-generation, and audio-alignment endpoints (PR1–PR5) are not built
> yet, so the prompt-only and hybrid flows below are aspirational and marked as
> such.

## Local mode

Hosted, API-key auth is PR1 and not implemented. For now every request must run
in local mode, which resolves to a deterministic development workspace:

```bash
AUTH_MODE=local npm run dev
```

Without `AUTH_MODE=local`, every `/api/v1` request returns a typed
`auth_not_configured` (HTTP 501) error.

## Implemented endpoints (PR6)

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/v1/projects/:projectId/timelines/:timelineId/revisions` | Wired to the editorial agent. Creates a sibling cut. |
| `GET` | `/api/v1/projects/:projectId/timelines/:timelineId/revisions/:jobId` | Poll a revision job. |
| `POST` | `/api/v1/projects/:projectId/timelines/:timelineId/exports` | Skeleton. Validates + plans duration, emits a `pending_render` artifact. |
| `GET` | `/api/v1/projects/:projectId/exports/:jobId` | Poll an export job. |
| `GET` | `/api/v1/projects/:projectId/artifacts/:artifactId` | Read an artifact record. |

Jobs use the scope doc's envelope shape:

```json
{ "job": { "id": "job_…", "type": "revision", "status": "succeeded", "projectId": "proj_…", "createdAt": "…", "updatedAt": "…" } }
```

Errors use the stable error envelope:

```json
{ "error": { "code": "audio_timeline_mismatch", "message": "…", "requestId": "req_…", "details": {} } }
```

See [revision.http](./revision.http) and [export.http](./export.http) for
request/response examples.

## Target agent flows

These are the three PR6 acceptance flows. Today only the revise → export tail
runs; the asset/composition/generation steps depend on PR1–PR5.

1. **Asset-driven** — register source media → generate timeline → revise →
   export. _(generate timeline needs PR4; export render needs PR5.)_
2. **Prompt-only** — brief → composition plans generated assets → generate
   timeline → export. _(needs PR2/PR3/PR4/PR5.)_
3. **Hybrid** — provide some assets, generate the rest → timeline → export.
   _(needs PR1–PR5.)_

## Running the smoke harness

The smoke harness in
[`src/lib/agent-api/__tests__/agent-smoke.test.ts`](../../../src/lib/agent-api/__tests__/agent-smoke.test.ts)
covers the job lifecycle, idempotency, the revision worker, and the export
duration policy. The three full prompt→MP4 flows are declared with `test.todo`
until PR1–PR5 land.

```bash
npm test
```
