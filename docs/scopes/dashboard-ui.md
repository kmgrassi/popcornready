# Dashboard UI Scope

## Objective

Give an authenticated user a home surface they land on after login: a dashboard
where they can see their projects, their generation runs, their generated
assets, and their final video outputs across everything they own — not just one
project at a time. This is the logged-in "command center" that ties together the
project, asset, generation-run, and export resources already defined in
[API Contract V1](./api-contract-v1.md) and
[Generation Progress UI](./generation-progress-ui.md).

The current `/api/v1` surface is almost entirely **project-scoped** (you must
already know a `projectId` to list assets, runs, or exports). A dashboard needs
to read **across all projects in a workspace**. The main new backend work in
this scope is a small set of workspace-level aggregate read endpoints; the main
new frontend work is the dashboard shell, navigation menu bar, and the
list/detail views that consume them.

## Product Goals

- After sign-in, the user lands on a dashboard, not a blank prompt box.
- The user can answer, at a glance: What have I made? What is generating right
  now? What finished? What failed?
- The user can navigate between Projects, Runs, Assets, and Outputs from a
  persistent menu bar.
- Every list links into the existing per-project detail and progress views
  rather than reinventing them.
- The dashboard works in `AUTH_MODE=local` against the deterministic
  `dev_workspace` exactly as it does for a hosted Supabase user.

## Non-Goals

- No new editing or generation surface. The dashboard reads and navigates; the
  prompt/studio flow and the run progress view already own creation and editing.
- No workspace administration (member invites, role management, API keys, billing)
  in this first pass. Those get their own scope; the menu bar should leave room
  for them.
- No real-time push. Dashboard lists use the same polling model as
  [Generation Progress UI](./generation-progress-ui.md); SSE/WebSockets are
  deferred.
- No cross-workspace global view. The dashboard is scoped to the active
  workspace; a workspace switcher selects which one is active.
- No hosted object-storage migration. Outputs and assets continue to reference
  artifacts by ID and URL so storage can move later.

## Information Architecture

The authenticated app gets a persistent left or top **menu bar** with these
primary destinations:

| Nav item | Route | Shows |
| --- | --- | --- |
| Home / Overview | `/dashboard` | Summary cards + most recent activity (active runs, recent outputs). |
| Projects | `/projects` | All projects in the active workspace, newest first. |
| Runs | `/runs` | All generation runs across projects, with status filter. |
| Assets | `/assets` | All generated and uploaded assets across projects (library/grid). |
| Outputs | `/outputs` | Finished, exported videos across projects (the "final outputs" gallery). |

Plus persistent chrome:

- A workspace selector (single workspace for v1, but the control exists).
- Account menu (profile, sign out) sourced from `GET /api/v1/me`.
- A primary "New video" / "New project" call to action that enters the existing
  creation flow.

Each list row deep-links into existing detail surfaces:

- A run → the run progress view at `/projects/:projectId/runs/:runId`.
- An output → its project + timeline/export.
- An asset → its project asset detail.

## Data Sources And Reuse

The dashboard composes resources that already exist. It must not introduce a
parallel status vocabulary or a second copy of run/job state.

- Identity and workspace memberships: `GET /api/v1/me`.
- Projects: `GET /api/v1/projects` (already workspace-scoped via the actor).
- Runs, stages, items: the `GenerationRun` / `GenerationStage` /
  `GenerationStageItem` model from
  [Generation Progress UI](./generation-progress-ui.md).
- Assets: the asset model from [API Contract V1](./api-contract-v1.md).
- Outputs: successful `export` jobs and their artifacts.

The gap is that runs, assets, and exports are currently only listable **under a
known project**. The dashboard needs them listable **per workspace**.

## API Scope

Add workspace-level aggregate read endpoints. All are `GET`, cursor-paginated
(`limit` default 50 / max 100, opaque `cursor`), newest-first, and follow the
list envelope and error shapes in [API Contract V1](./api-contract-v1.md). All
resolve the active workspace from the request actor and enforce workspace
membership (`viewer` is sufficient — these are read-only).

### Overview summary

- `GET /api/v1/workspaces/:workspaceId/dashboard`
  - Returns a small, denormalized summary for the Home view so the dashboard
    renders in one request instead of N.
  - Suggested shape:

```json
{
  "summary": {
    "schemaVersion": "dashboard.v1",
    "counts": {
      "projects": 12,
      "activeRuns": 2,
      "outputs": 34
    },
    "activeRuns": [
      {
        "runId": "run_123",
        "projectId": "proj_123",
        "projectName": "Harper launch teaser",
        "status": "running",
        "currentStageType": "asset_generation",
        "progressPercent": 45,
        "updatedAt": "2026-05-31T12:00:10.000Z"
      }
    ],
    "recentOutputs": [
      {
        "artifactId": "art_123",
        "projectId": "proj_123",
        "projectName": "Harper launch teaser",
        "thumbnailUrl": "...",
        "durationSec": 15,
        "createdAt": "2026-05-30T12:00:00.000Z"
      }
    ]
  }
}
```

`activeRuns` and `recentOutputs` are capped (e.g. 5–10 each); the full lists live
on the dedicated routes below.

### Cross-project runs

- `GET /api/v1/workspaces/:workspaceId/generation-runs`
  - Lists runs across all of the workspace's projects.
  - Query params: `status` (one of `queued|running|succeeded|failed|canceled`),
    `projectId` (optional narrowing), `limit`, `cursor`.
  - Each item is the existing `GenerationRun` plus a denormalized `projectName`
    so the UI does not need a second lookup per row.

### Cross-project assets

- `GET /api/v1/workspaces/:workspaceId/assets`
  - Lists uploaded and generated assets across projects.
  - Query params: `kind` (`image|video|audio|...`), `source`
    (`uploaded|generated`), `projectId`, `limit`, `cursor`.
  - Items reference assets by ID and URL/thumbnail URL, storage-neutral.

### Cross-project outputs

- `GET /api/v1/workspaces/:workspaceId/outputs`
  - Lists finished, successfully exported videos across projects (the "final
    outputs" the user cares about most).
  - Backed by successful `export` jobs / their artifacts.
  - Query params: `projectId`, `limit`, `cursor`.
  - Each item carries `artifactId`, `projectId`, `projectName`, optional
    `timelineId`, `thumbnailUrl`, `durationSec`, `format`, and `createdAt`.

### Implementation notes

- These are read aggregations over the **existing** local v1 stores. In the
  current codebase that state is split across two stacks, and the dashboard must
  join (or first unify) them rather than reading only one:
  - `src/lib/api/v1/store.ts` → `.local/agent-store.json` (projects, assets) and
    `src/lib/api/v1/jobs.ts` → `.local/agent-jobs.json` (jobs, including
    exports). These back the documented `/api/v1` project/asset/generation/export
    routes.
  - `src/lib/v1/store.ts` and `src/lib/v1/generation-runs.ts` → `.local/dev-db/`
    (generation runs, stages, stage items).
  - Aggregation joins these by `projectId`. Reading only `.local/dev-db/` would
    surface runs while missing the projects, assets, and outputs created through
    the v1 API — and vice versa. PR 1 should either query both stores behind one
    aggregation layer or first consolidate them onto a single store.
- v1 can iterate the workspace's projects and merge/sort in memory. The response
  shape must stay storage-neutral so a later indexed database query can replace
  the in-memory merge — and any store consolidation — without changing the
  contract.
- Use `Cache-Control: no-store` for the dashboard summary and runs list, since
  they reflect live generation state.
- No new mutating routes are introduced by this scope.

## UI Scope

- **App shell**: a persistent menu bar / nav that wraps all authenticated
  routes, with the workspace selector, account menu, and primary creation CTA.
  Renders identically in local and hosted auth modes; account/workspace details
  come from `/me`.
- **Home / Overview**: summary count cards (Projects, Active Runs, Outputs), an
  "In progress" strip of active runs (reusing the stage/status presentation from
  the progress UI, in compact form), and a "Recent outputs" strip. Empty state
  guides a first-time user into creating their first video.
- **Projects view**: card or table list of projects with name, status, last
  activity, and a thumbnail of the latest output; links into the project.
- **Runs view**: list of runs across projects with status chips, current stage,
  elapsed/updated time, and a status filter. Reuses the existing run-status
  vocabulary and color treatment. Rows link to
  `/projects/:projectId/runs/:runId`.
- **Assets view**: a responsive grid/library of assets with kind and source
  filters, thumbnails, and a link to the owning project. Reuses asset card
  presentation where it already exists.
- **Outputs view**: a gallery of finished videos with inline preview/playback,
  duration, project, and created date — the showcase of completed work.
- **Loading / empty / error states**: every list has a skeleton loading state,
  a polished empty state, and a typed-error state that reads the standard error
  envelope.
- **Polling**: the Home view and Runs view poll while active runs exist, slow or
  pause polling when the tab is hidden, and poll immediately on focus — matching
  [Generation Progress UI](./generation-progress-ui.md). Static views (Outputs,
  Assets) fetch on navigation and on manual refresh.

## Proposed PR Sequence

### PR 1: Workspace dashboard read API

Add the four workspace-scoped read endpoints (`/dashboard`, `/generation-runs`,
`/assets`, `/outputs`) with cursor pagination, filters, denormalized
`projectName`, and `viewer`-level access checks.

Acceptance criteria:

- Each endpoint lists across all projects in the workspace, newest first.
- Aggregation joins the project/asset/export store (`.local/agent-store.json`,
  `.local/agent-jobs.json`) with the generation-run store (`.local/dev-db/`) by
  `projectId`, so runs, projects, assets, and outputs created through the v1 API
  all appear together.
- Pagination, filters, and the standard list/error envelopes work.
- Responses are storage-neutral and use `no-store` where state is live.
- Works in `AUTH_MODE=local` against `dev_workspace` with no auth configured.

### PR 2: Dashboard shared types and client

Add shared TypeScript types for the dashboard summary and aggregate list items,
and a typed client/data layer the UI consumes (including polling helpers reused
from the progress UI).

Acceptance criteria:

- Types are shared by server and client code.
- Client functions cover all four endpoints with pagination and filters.
- No new status vocabulary is introduced; run/job states are reused.

### PR 3: App shell and menu bar

Add the persistent authenticated layout: menu bar, workspace selector, account
menu (from `/me`), and the primary creation CTA. Wire routing for the dashboard
destinations.

Acceptance criteria:

- All authenticated routes render inside the shell.
- Navigation between Home, Projects, Runs, Assets, and Outputs works.
- Account/workspace chrome renders correctly in local and hosted modes.

### PR 4: Home / Overview view

Build the summary cards, active-runs strip, recent-outputs strip, and first-run
empty state against `GET /workspaces/:id/dashboard`.

Acceptance criteria:

- The overview renders from a single summary request.
- Active runs show live status and link into the run progress view.
- A new user with no projects sees a clear path to create their first video.

### PR 5: Runs, Assets, and Outputs views

Build the three full list/library views with filters, pagination, loading/empty/
error states, and deep links into existing detail surfaces.

Acceptance criteria:

- Runs list filters by status and links to `/projects/:projectId/runs/:runId`.
- Assets grid filters by kind/source and links to the owning project.
- Outputs gallery previews finished videos and links to their project/timeline.
- Each view handles loading, empty, and typed-error states.

### PR 6: Polling, recovery, and post-login landing

Make Home/Runs poll active runs with tab-visibility backoff, recover the
dashboard after refresh, and route successful sign-in (and the local-mode
default) to `/dashboard`.

Acceptance criteria:

- Active runs update on the dashboard without a manual refresh.
- Polling slows/pauses when the tab is hidden and resumes on focus.
- After login (or in local mode), the user lands on the dashboard.

## Open Decisions

- Whether the dashboard summary should be a dedicated endpoint (chosen here for a
  one-request Home render) or composed client-side from the individual list
  endpoints.
- Whether "Outputs" should be keyed on export artifacts or on timelines that have
  at least one successful export.
- Whether Assets should default to generated-only or include uploaded source
  assets in the same library view.
- Menu bar placement (left rail vs. top bar) and how much it should anticipate
  the future workspace-admin section.
- Whether cross-project aggregation needs an index now, or whether in-memory
  merge over the local store is acceptable until project counts grow.

## Risks

- In-memory cross-project aggregation is fine locally but will not scale; the
  storage-neutral contract is what lets a later indexed query replace it without
  touching the UI.
- Polling every active run from the dashboard plus the open progress view can
  duplicate load; tab-visibility backoff and shared polling helpers are required
  from the first implementation.
- Denormalized fields like `projectName` can drift; treat them as display-time
  conveniences, not the source of truth.
- The menu bar will accrete destinations (workspace admin, billing, API keys);
  designing it as an extensible nav now avoids a rewrite later.

## End-State Acceptance Criteria

- After sign-in (or on local-mode start), the user lands on a dashboard showing
  their projects, active runs, and recent outputs.
- The user can navigate Projects, Runs, Assets, and Outputs from a persistent
  menu bar without knowing any project ID up front.
- Each cross-project list is workspace-scoped, paginated, filterable, and links
  into the existing per-project detail and run-progress views.
- An in-progress generation appears on the dashboard and updates without a manual
  refresh; a finished video appears in Outputs.
- The entire dashboard works in `AUTH_MODE=local` against `dev_workspace` and in
  hosted mode against a Supabase-authenticated user, sharing one API contract.
