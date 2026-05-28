# Project Model And Storage Scope

## Objective

Replace the MVP single JSON project with a durable, project-scoped data model
that supports browser users, agent clients, async jobs, multiple timelines, and
export artifacts.

## Required Entities

- `User`: internal profile mapped to a Supabase user.
- `Workspace`: tenant boundary for projects, members, API keys, assets, jobs,
  and artifacts.
- `WorkspaceMembership`: user role within a workspace.
- `AgentClient`: workspace-scoped API key metadata and scopes.
- `Project`: name, workspace, owner, brief, default settings, status.
- `Asset`: source media metadata and storage pointers.
- `ClipContext`: user or agent annotations attached to assets.
- `BriefVersion`: immutable context snapshot used for a generation.
- `Timeline`: validated structured edit.
- `TimelineVersion`: revision history and patch provenance.
- `Job`: async ingest, generation, revision, or export work.
- `Artifact`: rendered MP4, thumbnails, proxies, transcripts, or analysis files.
- `AuditEvent`: durable record of important project changes.

## Storage Recommendations

- Use Supabase Postgres for users, workspaces, memberships, project data,
  timeline versions, jobs, and audit events.
- Use object storage for source videos, generated thumbnails, proxies, and
  exports.
- Use simple JSON files plus local media directories for local development. This
  keeps the local path easy to inspect and avoids adding SQLite until concurrent
  local writes require it.
- Treat project metadata as soft-deletable in v1. Copied source assets and
  generated artifacts can be hard-deleted according to retention policy because
  they are managed copies/derivatives.
- Store timeline JSON in Postgres JSONB with schema version and derived columns
  for querying.
- Store large analysis outputs in object storage if they become too large for
  normal relational rows.

## Schema Versioning

Every persisted structured object should include a schema version:

```ts
interface VersionedTimeline {
  schemaVersion: "timeline.v1";
  id: string;
  projectId: string;
  segments: TimelineSegment[];
}
```

The application should validate and migrate known schema versions at read
boundaries. External API responses should include the schema version so agents
can reason about compatibility.

## Migration Path From MVP

1. Add `workspaceId`, `projectId`, and request actor context to current types
   and route handlers.
2. Introduce repository functions behind `src/lib/store.ts` so callers stop
   depending on file storage behavior.
3. Add a fully local development repository mode with deterministic
   `dev_workspace` and `dev_user` records, simple JSON project/job files, local
   uploads, local exports, and local media directories.
4. Add tests around repository behavior using the existing file store.
5. Swap implementation to Supabase Postgres and object storage without changing
   route-level business logic.
6. Add backfill/migration utilities for existing local MVP projects if needed.

## Acceptance Criteria

- Multiple users can belong to one or more workspaces.
- Project access is scoped by workspace membership or agent API key scope.
- Multiple projects can exist independently.
- A project can have multiple source assets, multiple timelines, and multiple
  exports.
- Revision jobs create sibling timelines rather than mutating the original
  timeline in place.
- A failed generation or export cannot overwrite the last good timeline.
- Every timeline can be traced to the brief version, asset context, model call,
  and patches that created it.
