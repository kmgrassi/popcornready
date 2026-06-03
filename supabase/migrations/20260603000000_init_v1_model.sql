-- Popcorn Ready — v1 data model (full).
--
-- Translates the TypeScript persistence contracts into Postgres:
--   * src/lib/api/v1/store.ts  -> workspaces, projects, brief_versions, assets, idempotency
--   * src/lib/v1/types.ts       -> compositions, jobs, timelines, edit_graphs,
--                                  generation_runs, generation_stages, generation_stage_items
--
-- IDs stay TEXT to match the app's generated id scheme (prj_*, ws_*, asset_*, ...).
-- Timestamps stay timestamptz; the app already writes ISO-8601 strings.
-- Loosely-shaped / still-churning structures (briefs, segments, provenance,
-- edit-graph documents, progress, errors) are stored as jsonb.
--
-- Ownership model: a workspace belongs to one Supabase auth user
-- (auth.ts maps user.id -> ws_user_<uid>). RLS keys every row to auth.uid()
-- by walking back to its owning workspace.

set check_function_bodies = off;

-- ---------------------------------------------------------------------------
-- Enums (mirror the TS string unions)
-- ---------------------------------------------------------------------------
create type project_status        as enum ('active', 'deleted');
create type asset_kind            as enum ('video', 'image', 'audio');
create type asset_status          as enum ('pending', 'processing', 'ready', 'failed');
create type composition_mode      as enum ('asset_driven', 'prompt_only', 'hybrid');
create type composition_status    as enum ('planning', 'generating_assets', 'ready_for_timeline', 'failed');
create type job_type              as enum ('asset_ingest', 'asset_generation', 'composition', 'generation', 'revision', 'export', 'audio_alignment');
create type job_status            as enum ('queued', 'running', 'succeeded', 'failed', 'canceled');
create type generation_stage_type as enum ('brief_intake', 'creative_plan', 'asset_generation', 'audio_generation', 'timeline_assembly', 'quality_review', 'export', 'ready');
create type stage_item_kind       as enum ('image', 'video', 'audio', 'caption', 'timeline', 'export');

-- ---------------------------------------------------------------------------
-- Core ownership
-- ---------------------------------------------------------------------------
create table workspaces (
  id             text primary key,
  schema_version text        not null default 'workspace.v1',
  owner_id       uuid        references auth.users (id) on delete cascade,
  name           text        not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
comment on column workspaces.owner_id is
  'Supabase auth user that owns this workspace. Maps to auth.ts ws_user_<uid>. Null for the seeded local dev workspace.';

create table projects (
  id                       text primary key,
  schema_version           text          not null default 'project.v1',
  workspace_id             text          not null references workspaces (id) on delete cascade,
  name                     text          not null,
  status                   project_status not null default 'active',
  brief                    jsonb,
  current_brief_version_id text,
  created_at               timestamptz   not null default now(),
  updated_at               timestamptz   not null default now()
);
create index projects_workspace_id_idx on projects (workspace_id);

create table brief_versions (
  id             text primary key,
  schema_version text        not null default 'brief.v1',
  project_id     text        not null references projects (id) on delete cascade,
  brief          jsonb       not null,
  created_at     timestamptz not null default now()
);
create index brief_versions_project_id_idx on brief_versions (project_id);
-- current_brief_version_id points here; added as FK after both tables exist.
alter table projects
  add constraint projects_current_brief_version_fk
  foreign key (current_brief_version_id) references brief_versions (id) on delete set null;

create table assets (
  id                       text primary key,
  schema_version           text        not null default 'asset.v1',
  workspace_id             text        not null references workspaces (id) on delete cascade,
  project_id               text        not null references projects (id) on delete cascade,
  kind                     asset_kind  not null,
  status                   asset_status not null default 'pending',
  filename                 text        not null,
  -- served/managed path the renderer reads (api/v1 store uses remote_url/storage_key)
  url                      text,
  remote_url               text,
  storage_key              text,
  source                   text        not null,
  duration_sec             double precision,
  description              text,
  context                  jsonb,
  semantic_analysis        jsonb,
  provenance               jsonb,
  generated_asset_job_id   text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create index assets_project_id_idx   on assets (project_id);
create index assets_workspace_id_idx on assets (workspace_id);

-- ---------------------------------------------------------------------------
-- Composition / jobs / timeline / edit graph
-- ---------------------------------------------------------------------------
create table compositions (
  id                       text primary key,
  schema_version           text               not null default 'composition.v1',
  project_id               text               not null references projects (id) on delete cascade,
  brief_version_id         text               references brief_versions (id) on delete set null,
  mode                     composition_mode   not null,
  status                   composition_status not null default 'planning',
  planned_beats            jsonb              not null default '[]'::jsonb,
  generated_asset_job_ids  jsonb              not null default '[]'::jsonb,
  ready_asset_ids          jsonb              not null default '[]'::jsonb,
  narration_strategy       jsonb,
  created_at               timestamptz        not null default now(),
  updated_at               timestamptz        not null default now()
);
create index compositions_project_id_idx on compositions (project_id);

create table jobs (
  id              text primary key,
  schema_version  text        not null default 'job.v1',
  workspace_id    text        not null references workspaces (id) on delete cascade,
  project_id      text        not null references projects (id) on delete cascade,
  request_id      text,
  type            job_type    not null,
  status          job_status  not null default 'queued',
  progress        jsonb       not null default '{}'::jsonb,
  input           jsonb,
  result          jsonb,
  error           jsonb,
  idempotency_key text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index jobs_project_id_idx   on jobs (project_id);
create index jobs_workspace_id_idx on jobs (workspace_id);

create table edit_graphs (
  id               text primary key,
  schema_version   text        not null default 'editGraph.v1',
  project_id       text        not null references projects (id) on delete cascade,
  brief_version_id text        references brief_versions (id) on delete set null,
  composition_id   text        references compositions (id) on delete set null,
  -- full EditGraphDocument (nodes/edges/timeline projection/provenance)
  document         jsonb       not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index edit_graphs_project_id_idx on edit_graphs (project_id);

create table timelines (
  id               text primary key,
  schema_version   text        not null default 'timeline.v1',
  project_id       text        not null references projects (id) on delete cascade,
  brief_version_id text        references brief_versions (id) on delete set null,
  composition_id   text        references compositions (id) on delete set null,
  aspect_ratio     text        not null,
  fps              integer     not null,
  show_captions    boolean,
  segments         jsonb       not null default '[]'::jsonb,
  provenance       jsonb       not null,
  derived_from     jsonb,
  created_by       jsonb       not null,
  created_at       timestamptz not null default now()
);
create index timelines_project_id_idx on timelines (project_id);

-- ---------------------------------------------------------------------------
-- Generation runs (progress UI aggregate)
-- ---------------------------------------------------------------------------
create table generation_runs (
  run_id             text primary key,
  project_id         text                  not null references projects (id) on delete cascade,
  brief_version_id   text                  references brief_versions (id) on delete set null,
  status             job_status            not null default 'queued',
  review_gates       jsonb,
  review_gate        jsonb,
  current_stage_type generation_stage_type,
  progress_percent   double precision,
  message            text,
  error              jsonb,
  created_at         timestamptz           not null default now(),
  updated_at         timestamptz           not null default now(),
  started_at         timestamptz,
  completed_at       timestamptz
);
create index generation_runs_project_id_idx on generation_runs (project_id);

create table generation_stages (
  stage_id         text primary key,
  run_id           text                  not null references generation_runs (run_id) on delete cascade,
  type             generation_stage_type not null,
  label            text                  not null,
  "order"          integer               not null,
  status           job_status            not null default 'queued',
  is_review_gate   boolean,
  reviewed_at      timestamptz,
  progress_percent double precision,
  message          text,
  started_at       timestamptz,
  completed_at     timestamptz,
  job_ids          jsonb                 not null default '[]'::jsonb,
  artifact_ids     jsonb                 not null default '[]'::jsonb,
  error            jsonb,
  created_at       timestamptz           not null default now(),
  updated_at       timestamptz           not null default now()
);
create index generation_stages_run_id_idx on generation_stages (run_id);

create table generation_stage_items (
  item_id          text primary key,
  stage_id         text            not null references generation_stages (stage_id) on delete cascade,
  kind             stage_item_kind not null,
  label            text            not null,
  status           job_status      not null default 'queued',
  progress_percent double precision,
  provider         text,
  prompt_preview   text,
  asset_id         text            references assets (id) on delete set null,
  artifact_id      text,
  retryable        boolean,
  error            jsonb,
  created_at       timestamptz     not null default now(),
  updated_at       timestamptz     not null default now()
);
create index generation_stage_items_stage_id_idx on generation_stage_items (stage_id);

-- ---------------------------------------------------------------------------
-- Idempotency (superset of both stores' shapes)
-- ---------------------------------------------------------------------------
-- Composite (scope, key): the api/v1 store matches on both. The lib/v1 store
-- keys by scope alone and stores key = '' (the column default).
create table idempotency (
  scope         text        not null,
  key           text        not null default '',
  body_hash     text,
  request_hash  text,
  job_id        text,
  status        integer,
  response_body jsonb,
  created_at    timestamptz not null default now(),
  primary key (scope, key)
);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
-- Helper: does the current user own this workspace?
create or replace function owns_workspace(ws_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from workspaces w
    where w.id = ws_id and w.owner_id = auth.uid()
  );
$$;

-- Helper: does the current user own the workspace this project belongs to?
create or replace function owns_project(proj_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from projects p
    join workspaces w on w.id = p.workspace_id
    where p.id = proj_id and w.owner_id = auth.uid()
  );
$$;

alter table workspaces             enable row level security;
alter table projects               enable row level security;
alter table brief_versions         enable row level security;
alter table assets                 enable row level security;
alter table compositions           enable row level security;
alter table jobs                   enable row level security;
alter table edit_graphs            enable row level security;
alter table timelines              enable row level security;
alter table generation_runs        enable row level security;
alter table generation_stages      enable row level security;
alter table generation_stage_items enable row level security;
alter table idempotency            enable row level security;

-- Workspaces: a user sees/edits only workspaces they own.
create policy workspaces_owner on workspaces
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Workspace-scoped tables.
create policy projects_owner on projects
  for all using (owns_workspace(workspace_id)) with check (owns_workspace(workspace_id));
create policy assets_owner on assets
  for all using (owns_workspace(workspace_id)) with check (owns_workspace(workspace_id));
create policy jobs_owner on jobs
  for all using (owns_workspace(workspace_id)) with check (owns_workspace(workspace_id));

-- Project-scoped tables (walk project -> workspace).
create policy brief_versions_owner on brief_versions
  for all using (owns_project(project_id)) with check (owns_project(project_id));
create policy compositions_owner on compositions
  for all using (owns_project(project_id)) with check (owns_project(project_id));
create policy edit_graphs_owner on edit_graphs
  for all using (owns_project(project_id)) with check (owns_project(project_id));
create policy timelines_owner on timelines
  for all using (owns_project(project_id)) with check (owns_project(project_id));
create policy generation_runs_owner on generation_runs
  for all using (owns_project(project_id)) with check (owns_project(project_id));

-- Run-descendant tables (walk back through the run's project).
create policy generation_stages_owner on generation_stages
  for all using (
    exists (select 1 from generation_runs r
            where r.run_id = generation_stages.run_id and owns_project(r.project_id))
  ) with check (
    exists (select 1 from generation_runs r
            where r.run_id = generation_stages.run_id and owns_project(r.project_id))
  );
create policy generation_stage_items_owner on generation_stage_items
  for all using (
    exists (select 1 from generation_stages s
            join generation_runs r on r.run_id = s.run_id
            where s.stage_id = generation_stage_items.stage_id and owns_project(r.project_id))
  ) with check (
    exists (select 1 from generation_stages s
            join generation_runs r on r.run_id = s.run_id
            where s.stage_id = generation_stage_items.stage_id and owns_project(r.project_id))
  );

-- Idempotency is internal bookkeeping; no end-user reaches it directly. With RLS
-- on and no policy, only the service_role key (used server-side) can touch it.
