# Auth And App Architecture Scope

## Objective

Adopt the same product architecture pattern used by the Parallel Agent platform:
a Vite-style React browser app, an Express API server, and Supabase
authentication for hosted environments. Local development must still be able to
run without Supabase or login.

## Architecture Baseline

- Vite-style React app is the primary browser client. We do not need Next.js SEO
  or server rendering for the production app because this is a complex
  authenticated tool surface.
- Express server owns `/api/v1` and all project, asset, generation, revision,
  export, and job endpoints.
- Supabase Auth is the source of truth for browser user identity.
- Express verifies Supabase JWTs on authenticated requests.
- Express resolves a normalized request context before business logic runs.
- Shared TypeScript schemas define request bodies, response bodies, persisted
  objects, and model-output contracts.
- The repository should use a monorepo layout with `apps/web` for the Vite-style
  React client, `apps/api` for the Express server, and `packages/*` for shared
  schemas, timeline logic, rendering helpers, and agent code.
- Local development uses fully local files for project data, uploaded videos,
  generated artifacts, and job state until we intentionally wire in hosted
  services.

## Request Context

Every API request should resolve to one of these identity modes:

```ts
type RequestActor =
  | {
      type: "user";
      userId: string;
      supabaseUserId: string;
      workspaceIds: string[];
    }
  | {
      type: "agent";
      agentClientId: string;
      workspaceId: string;
      scopes: string[];
    }
  | {
      type: "local_dev";
      userId: "dev_user";
      workspaceId: "dev_workspace";
    };
```

Production and shared staging should allow only `user` and `agent` actors.
`local_dev` is enabled only by an explicit local environment flag.

## Local Auth Bypass

Local development should not require Supabase.

Recommended behavior:

- `AUTH_MODE=local` enables unauthenticated local requests.
- `AUTH_MODE=supabase` enables normal Supabase JWT validation.
- `AUTH_MODE` defaults to `supabase` outside local development.
- Local mode injects a deterministic `dev_user` and `dev_workspace`.
- Local mode bypasses browser login and agent API key validation.
- Local mode uses local file storage for project data, uploads, exports, and job
  state.
- Local mode should log a clear startup warning.
- Local mode should be rejected in production environments.

The goal is fast local iteration, not a weaker production mode.

## Supabase User Flow

- React app uses Supabase client libraries for sign in, sign out, session
  refresh, and account state.
- React app sends the Supabase access token to Express as a bearer token.
- Express verifies the JWT and maps the Supabase user to an internal `User`.
- Express loads workspace memberships and enforces project access.
- New users self-create their first workspace after sign-up. They can later
  invite additional users into that workspace.

## Supabase Environment Variables

Use the same Supabase environment variable contract as the Parallel Agent
platform. For now, Popcorn Ready should point at the dev environment for the Harper
database.

Server-side variables:

- `SUPABASE_PROJECT_ID`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Browser variables:

- `VITE_SUPABASE_ENV`
- `VITE_SUPABASE_DEV_URL`
- `VITE_SUPABASE_DEV_ANON_KEY`
- `VITE_SUPABASE_PROD_URL`
- `VITE_SUPABASE_PROD_ANON_KEY`

Local `AUTH_MODE=local` should not require these variables. Hosted
`AUTH_MODE=supabase` should fail fast when required Supabase variables are
missing.

## Workspace Authorization

Minimum v1 roles:

- `owner`: manage workspace settings, members, API keys, and all projects.
- `editor`: create/edit projects, upload assets, generate timelines, export.
- `viewer`: read projects, timelines, and artifacts.

Permission checks should happen in server-side policy helpers, not in route
handlers directly.

Examples:

```ts
requireWorkspaceRole(ctx, workspaceId, ["owner", "editor"]);
requireProjectAccess(ctx, projectId, "projects:write");
```

## Agent Authentication

Agent API keys should be workspace-scoped.

- Store only hashed API keys.
- Show only the key prefix after creation.
- Attach explicit scopes to each key.
- Resolve agent requests into the same authorization layer used by users.
- Record `createdByAgentId` on mutations performed by agents.
- In `AUTH_MODE=local`, agent requests bypass API key validation and resolve to
  the deterministic `dev_workspace`. This is required so local agents can drive
  the API without secret provisioning.

Initial scopes:

- `projects:read`
- `projects:write`
- `assets:read`
- `assets:write`
- `jobs:read`
- `jobs:write`
- `artifacts:read`

API keys are sufficient for v1 hosted agent access. OAuth-style third-party
authorization is intentionally out of scope until there is a concrete external
integration need.

## Migration From Current MVP

1. Introduce shared schemas and project/workspace IDs in the current codebase.
2. Add an Express API server with health and project routes.
3. Move browser API calls to `/api/v1`.
4. Add request-context middleware with `AUTH_MODE=local`.
5. Add Supabase JWT verification for `AUTH_MODE=supabase`.
6. Move generation/export routes behind Express and job creation.
7. Move the browser app from Next.js to a Vite-style React client once the API
   boundary is stable.

## Local Directory Layout

Local development should use simple JSON files and local media directories:

```txt
.local/
  dev-db/
    users.json
    workspaces.json
    memberships.json
    api-keys.json
    projects/
      {projectId}.json
    jobs/
      {jobId}.json
    timelines/
      {timelineId}.json
    artifacts/
      {artifactId}.json
  media/
    uploads/
      {workspaceId}/{projectId}/
    thumbnails/
      {workspaceId}/{projectId}/
    exports/
      {workspaceId}/{projectId}/
```

This layout is intentionally inspectable and easy to reset. If concurrent local
jobs make JSON file locking painful, SQLite can be reconsidered later.

## Acceptance Criteria

- Local development can create projects, upload videos, generate timelines, and
  export without logging in or configuring agent API keys.
- Hosted environments require Supabase-authenticated users or valid agent API
  keys.
- Every project-scoped API request enforces workspace membership or agent scope.
- UI and agent clients share the same project, asset, job, timeline, and export
  API contracts.
