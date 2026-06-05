-- Supabase-generated UUID primary keys everywhere.
--
-- ===========================================================================
-- !! DESTRUCTIVE / RESET MIGRATION !!
-- ===========================================================================
-- The original v1 + eval schema minted TEXT primary keys app-side
-- (proj_*, asset_*, briefv_*, comp_*, job_*, eg_*, tl_*, genrun_*, evalrun_*,
-- judgment_*, …) and keyed workspaces on a TEXT id (ws_local_dev / ws_user_*).
-- This migration moves EVERY persisted entity to a DB-generated UUID primary key
-- (`uuid primary key default gen_random_uuid()`), and repoints every foreign-key
-- column that referenced those text ids to `uuid`.
--
-- Existing text ids like 'proj_abc' are NOT valid UUIDs, so an in-place
-- `alter column ... type uuid using id::uuid` would fail. The dev tables are
-- effectively empty (e.g. GET /eval/suites returns []), so this migration
-- DROPS and RECREATES the affected tables instead of attempting a cast.
--
-- *** THIS RESETS (DELETES ALL ROWS IN) the following tables ***:
--   workspaces, workspace_members, workspace_invites,
--   projects, brief_versions, assets, compositions, jobs, edit_graphs,
--   timelines, generation_runs, generation_stages, generation_stage_items,
--   generation_stage_artifacts, idempotency,
--   eval_suites, eval_cases, eval_runs, judgments, expectation_results.
--
-- public.users is preserved (its id is already a UUID); workspaces is dropped and
-- recreated, which also drops the auth-user mirror's workspace data. Apply ONLY
-- against an empty / disposable dev database. There is no down-migration.
--
-- IN-JSON KEYS ARE EXEMPT (the DB cannot generate them — they live inside jsonb
-- document columns, not as DB columns): edit-graph node ids, beat ids
-- (beat_${i}_${name}), timeline segment/clip ids, planned-beat ids, the eval
-- artifact ids stored inside eval_cases.artifacts. Ephemeral request/correlation
-- ids (req_*) are likewise not persisted PKs and are exempt.

set check_function_bodies = off;

-- ---------------------------------------------------------------------------
-- 0. Tear down everything keyed on the old text ids.
-- ---------------------------------------------------------------------------
-- Drop the v1 + eval tables (CASCADE clears their policies, indexes, triggers,
-- and cross-FKs). Order does not matter under CASCADE, but we list children
-- before parents for readability.
drop table if exists expectation_results        cascade;
drop table if exists judgments                  cascade;
drop table if exists eval_runs                  cascade;
drop table if exists eval_cases                 cascade;
drop table if exists eval_suites                cascade;

drop table if exists generation_stage_artifacts cascade;
drop table if exists generation_stage_items     cascade;
drop table if exists generation_stages          cascade;
drop table if exists generation_runs            cascade;
drop table if exists timelines                  cascade;
drop table if exists edit_graphs                cascade;
drop table if exists jobs                       cascade;
drop table if exists compositions               cascade;
drop table if exists assets                     cascade;
drop table if exists brief_versions             cascade;
drop table if exists projects                   cascade;

drop table if exists idempotency                cascade;

-- Workspace membership/invites reference workspaces.id (text); drop them so the
-- workspaces id type can change, then recreate against the uuid id below.
drop table if exists public.workspace_invites   cascade;
drop table if exists public.workspace_members   cascade;
drop table if exists public.workspaces          cascade;

-- The ownership helpers took `text` ids. CREATE OR REPLACE cannot change an
-- argument type, so drop them; they are recreated with uuid params further down.
drop function if exists public.owns_workspace(text)     cascade;
drop function if exists public.owns_project(text)       cascade;
drop function if exists public.is_workspace_member(text) cascade;
drop function if exists public.is_workspace_admin(text)  cascade;
drop function if exists public.handle_new_workspace()    cascade;
drop function if exists public.accept_workspace_invite(text) cascade;
drop function if exists public.expire_stale_workspace_invites() cascade;

-- ---------------------------------------------------------------------------
-- 1. Core ownership — workspaces keyed on a uuid id.
-- ---------------------------------------------------------------------------
create table public.workspaces (
  id             uuid primary key default gen_random_uuid(),
  schema_version text        not null default 'workspace.v1',
  -- Domain user (public.users.id) that owns this workspace; null for the seeded
  -- local dev workspace. (workspace_members migration repointed this off auth.users.)
  owner_id       uuid        references public.users (id) on delete set null,
  name           text        not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Natural-key uniqueness backing find-or-create (app no longer mints ids):
--   * One workspace per owning domain user (supersedes the old 1:1 ws_user_<id>).
--   * One unowned local dev workspace per name (supersedes ws_local_dev).
create unique index workspaces_unique_owner
  on public.workspaces (owner_id)
  where owner_id is not null;
create unique index workspaces_unique_local_name
  on public.workspaces (lower(name))
  where owner_id is null;

create trigger workspaces_set_updated_at
  before update on public.workspaces
  for each row execute function public.set_updated_at();

-- --- membership table (uuid workspace_id) ----------------------------------
create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id      uuid not null references public.users (id) on delete cascade,
  role         text not null default 'member' check (role in ('owner', 'admin', 'member')),
  invited_by   uuid references public.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index idx_workspace_members_user_id on public.workspace_members (user_id);

create trigger workspace_members_set_updated_at
  before update on public.workspace_members
  for each row execute function public.set_updated_at();

-- --- invites table (uuid id + uuid workspace_id) ---------------------------
create extension if not exists pgcrypto;

create table public.workspace_invites (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  email         text not null check (btrim(email) <> ''),
  role          text not null default 'member' check (role in ('owner', 'admin', 'member')),
  invited_by    uuid references public.users (id) on delete set null,
  token         text not null unique default encode(gen_random_bytes(32), 'hex'),
  status        text not null default 'pending'
                  check (status in ('pending', 'accepted', 'revoked', 'expired')),
  expires_at    timestamptz not null default (now() + interval '14 days'),
  accepted_by   uuid references public.users (id) on delete set null,
  accepted_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index idx_workspace_invites_workspace_id on public.workspace_invites (workspace_id);
create index idx_workspace_invites_email_lower on public.workspace_invites (lower(btrim(email)));
create unique index workspace_invites_unique_pending
  on public.workspace_invites (workspace_id, lower(btrim(email)))
  where status = 'pending';

create trigger workspace_invites_set_updated_at
  before update on public.workspace_invites
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Membership / ownership helpers + triggers (uuid params).
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_workspace()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.owner_id is not null then
    insert into public.workspace_members (workspace_id, user_id, role)
    values (new.id, new.owner_id, 'owner')
    on conflict (workspace_id, user_id) do nothing;
  end if;
  return new;
end;
$$;

create trigger on_workspace_created
  after insert on public.workspaces
  for each row execute function public.handle_new_workspace();

create or replace function public.is_workspace_member(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = p_workspace_id
      and wm.user_id = public.current_app_user_id()
  );
$$;
revoke all on function public.is_workspace_member(uuid) from public;
grant execute on function public.is_workspace_member(uuid) to authenticated, service_role;

create or replace function public.is_workspace_admin(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = p_workspace_id
      and wm.user_id = public.current_app_user_id()
      and wm.role in ('owner', 'admin')
  );
$$;
revoke all on function public.is_workspace_admin(uuid) from public;
grant execute on function public.is_workspace_admin(uuid) to authenticated, service_role;

-- The v1 RLS policies below call owns_workspace()/owns_project(); recreated here
-- with uuid params so access still follows membership + the domain identity.
create or replace function public.owns_workspace(ws_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_workspace_member(ws_id);
$$;

create or replace function public.owns_project(proj_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.projects p
    join public.workspace_members wm on wm.workspace_id = p.workspace_id
    where p.id = proj_id
      and wm.user_id = public.current_app_user_id()
  );
$$;

-- ---------------------------------------------------------------------------
-- 3. Invite accept/expire flows (uuid workspace_id; function now RETURNS uuid).
-- ---------------------------------------------------------------------------
create or replace function public.accept_workspace_invite(p_token text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id      uuid := public.current_app_user_id();
  v_invite       public.workspace_invites%rowtype;
  v_caller_email text;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select * into v_invite
  from public.workspace_invites
  where token = p_token
  for update;

  if not found then
    raise exception 'invite not found' using errcode = 'P0002';
  end if;

  if v_invite.status = 'accepted' and v_invite.accepted_by = v_user_id then
    return v_invite.workspace_id;
  end if;

  if v_invite.status <> 'pending' then
    raise exception 'invite is % (not pending)', v_invite.status using errcode = '22023';
  end if;

  if v_invite.expires_at <= now() then
    raise exception 'invite has expired' using errcode = '22023';
  end if;

  select email into v_caller_email from public.users where id = v_user_id;
  if v_caller_email is null
     or lower(btrim(v_caller_email)) is distinct from lower(btrim(v_invite.email)) then
    raise exception 'invite is addressed to a different email'
      using errcode = '42501';
  end if;

  insert into public.workspace_members (workspace_id, user_id, role, invited_by)
  values (v_invite.workspace_id, v_user_id, v_invite.role, v_invite.invited_by)
  on conflict (workspace_id, user_id) do nothing;

  update public.workspace_invites
    set status      = 'accepted',
        accepted_by = v_user_id,
        accepted_at = now()
    where id = v_invite.id;

  return v_invite.workspace_id;
end;
$$;
revoke all on function public.accept_workspace_invite(text) from public;
grant execute on function public.accept_workspace_invite(text) to authenticated, service_role;

create or replace function public.expire_stale_workspace_invites()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update public.workspace_invites
    set status = 'expired'
    where status = 'pending'
      and expires_at <= now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.expire_stale_workspace_invites() from public;
grant execute on function public.expire_stale_workspace_invites() to service_role;

-- ---------------------------------------------------------------------------
-- 4. Projects / briefs / assets — uuid PKs + uuid FKs.
-- ---------------------------------------------------------------------------
create table public.projects (
  id                       uuid primary key default gen_random_uuid(),
  schema_version           text          not null default 'project.v1',
  workspace_id             uuid          not null references public.workspaces (id) on delete cascade,
  name                     text          not null,
  status                   project_status not null default 'active',
  brief                    jsonb,
  current_brief_version_id uuid,
  created_at               timestamptz   not null default now(),
  updated_at               timestamptz   not null default now()
);
create index projects_workspace_id_idx on public.projects (workspace_id);

create table public.brief_versions (
  id             uuid primary key default gen_random_uuid(),
  schema_version text        not null default 'brief.v1',
  project_id     uuid        not null references public.projects (id) on delete cascade,
  brief          jsonb       not null,
  created_at     timestamptz not null default now()
);
create index brief_versions_project_id_idx on public.brief_versions (project_id);
alter table public.projects
  add constraint projects_current_brief_version_fk
  foreign key (current_brief_version_id) references public.brief_versions (id) on delete set null;

create table public.assets (
  id                       uuid primary key default gen_random_uuid(),
  schema_version           text        not null default 'asset.v1',
  workspace_id             uuid        not null references public.workspaces (id) on delete cascade,
  project_id               uuid        not null references public.projects (id) on delete cascade,
  kind                     asset_kind  not null,
  status                   asset_status not null default 'pending',
  filename                 text        not null,
  url                      text,
  remote_url               text,
  storage_key              text,
  source                   jsonb       not null,
  duration_sec             double precision,
  description              text,
  context                  jsonb,
  semantic_analysis        jsonb,
  provenance               jsonb,
  generated_asset_job_id   uuid,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create index assets_project_id_idx   on public.assets (project_id);
create index assets_workspace_id_idx on public.assets (workspace_id);

-- ---------------------------------------------------------------------------
-- 5. Composition / jobs / timeline / edit graph — uuid PKs + uuid FKs.
-- ---------------------------------------------------------------------------
create table public.compositions (
  id                       uuid primary key default gen_random_uuid(),
  schema_version           text               not null default 'composition.v1',
  project_id               uuid               not null references public.projects (id) on delete cascade,
  brief_version_id         uuid               references public.brief_versions (id) on delete set null,
  mode                     composition_mode   not null,
  status                   composition_status not null default 'planning',
  planned_beats            jsonb              not null default '[]'::jsonb,
  generated_asset_job_ids  jsonb              not null default '[]'::jsonb,
  ready_asset_ids          jsonb              not null default '[]'::jsonb,
  narration_strategy       jsonb,
  created_at               timestamptz        not null default now(),
  updated_at               timestamptz        not null default now()
);
create index compositions_project_id_idx on public.compositions (project_id);

create table public.jobs (
  id              uuid primary key default gen_random_uuid(),
  schema_version  text        not null default 'job.v1',
  workspace_id    uuid        not null references public.workspaces (id) on delete cascade,
  project_id      uuid        not null references public.projects (id) on delete cascade,
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
create index jobs_project_id_idx   on public.jobs (project_id);
create index jobs_workspace_id_idx on public.jobs (workspace_id);

create table public.edit_graphs (
  id               uuid primary key default gen_random_uuid(),
  schema_version   text        not null default 'editGraph.v1',
  project_id       uuid        not null references public.projects (id) on delete cascade,
  brief_version_id uuid        references public.brief_versions (id) on delete set null,
  composition_id   uuid        references public.compositions (id) on delete set null,
  -- Full EditGraphDocument (nodes/edges/timeline projection/provenance). Its
  -- internal node ids + the document's own `id` field live INSIDE this jsonb and
  -- are app-generated (in-JSON keys are exempt from the DB-generated-uuid rule);
  -- the `id` column above is the DB-generated row key.
  document         jsonb       not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index edit_graphs_project_id_idx on public.edit_graphs (project_id);

create table public.timelines (
  id               uuid primary key default gen_random_uuid(),
  schema_version   text        not null default 'timeline.v1',
  project_id       uuid        not null references public.projects (id) on delete cascade,
  brief_version_id uuid        references public.brief_versions (id) on delete set null,
  composition_id   uuid        references public.compositions (id) on delete set null,
  aspect_ratio     text        not null,
  fps              integer     not null,
  show_captions    boolean,
  -- segment ids inside `segments` are in-JSON keys (exempt).
  segments         jsonb       not null default '[]'::jsonb,
  provenance       jsonb       not null,
  derived_from     jsonb,
  created_by       jsonb       not null,
  created_at       timestamptz not null default now()
);
create index timelines_project_id_idx on public.timelines (project_id);

-- ---------------------------------------------------------------------------
-- 6. Generation runs / stages / items / artifacts — uuid PKs + uuid FKs.
-- ---------------------------------------------------------------------------
create table public.generation_runs (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid                  not null references public.projects (id) on delete cascade,
  brief_version_id   uuid                  references public.brief_versions (id) on delete set null,
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
create index generation_runs_project_id_idx on public.generation_runs (project_id);

create table public.generation_stages (
  id               uuid primary key default gen_random_uuid(),
  run_id           uuid                  not null references public.generation_runs (id) on delete cascade,
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
  judgment         jsonb,
  created_at       timestamptz           not null default now(),
  updated_at       timestamptz           not null default now()
);
create index generation_stages_run_id_idx on public.generation_stages (run_id);

create table public.generation_stage_items (
  id               uuid primary key default gen_random_uuid(),
  stage_id         uuid            not null references public.generation_stages (id) on delete cascade,
  kind             stage_item_kind not null,
  label            text            not null,
  status           job_status      not null default 'queued',
  progress_percent double precision,
  provider         text,
  prompt_preview   text,
  asset_id         uuid            references public.assets (id) on delete set null,
  artifact_id      uuid,
  retryable        boolean,
  error            jsonb,
  judgment         jsonb,
  created_at       timestamptz     not null default now(),
  updated_at       timestamptz     not null default now()
);
create index generation_stage_items_stage_id_idx on public.generation_stage_items (stage_id);

create table public.generation_stage_artifacts (
  id         uuid primary key default gen_random_uuid(),
  run_id     uuid            not null references public.generation_runs (id) on delete cascade,
  stage_id   uuid            not null references public.generation_stages (id) on delete cascade,
  item_id    uuid            references public.generation_stage_items (id) on delete set null,
  kind       stage_item_kind not null,
  content    jsonb           not null,
  created_at timestamptz     not null default now()
);
create index generation_stage_artifacts_run_id_idx on public.generation_stage_artifacts (run_id);
create index generation_stage_artifacts_stage_id_idx on public.generation_stage_artifacts (stage_id);

-- generation_stage_items.artifact_id references a stage artifact, but is kept a
-- LOOSE uuid (no FK) — matching the original schema, where an item may point at
-- an artifact created in a separate write or an inline/offline artifact that is
-- not a generation_stage_artifacts row.

-- ---------------------------------------------------------------------------
-- 7. Idempotency (composite (scope, key) PK — unchanged shape).
-- ---------------------------------------------------------------------------
create table public.idempotency (
  scope         text        not null,
  key           text        not null default '',
  body_hash     text,
  request_hash  text,
  job_id        uuid,
  status        integer,
  response_body jsonb,
  created_at    timestamptz not null default now(),
  primary key (scope, key)
);

-- ---------------------------------------------------------------------------
-- 8. Eval entities — uuid PKs + uuid FKs.
-- ---------------------------------------------------------------------------
create table public.eval_suites (
  id          uuid primary key default gen_random_uuid(),
  name        text        not null,
  description text,
  created_at  timestamptz not null default now()
);

create table public.eval_cases (
  id            uuid primary key default gen_random_uuid(),
  suite_id      uuid        not null references public.eval_suites (id) on delete cascade,
  label         text        not null,
  stimulus      jsonb       not null,
  stages_to_run jsonb       not null default '[]'::jsonb,
  expectations  jsonb,
  -- artifact ids inside `artifacts` are in-JSON keys (exempt).
  artifacts     jsonb       not null default '[]'::jsonb,
  created_at    timestamptz not null default now()
);
create index eval_cases_suite_id_idx on public.eval_cases (suite_id);

create table public.eval_runs (
  id              uuid                 primary key default gen_random_uuid(),
  source          eval_run_source      not null default 'suite',
  suite_id        uuid                 references public.eval_suites (id) on delete set null,
  generation_mode eval_generation_mode not null default 'prompts_only',
  stop_after      generation_stage_type,
  git_sha         text                 not null,
  branch          text                 not null,
  judge_models    jsonb                not null default '{}'::jsonb,
  status          eval_run_status      not null default 'queued',
  aggregate       jsonb,
  created_at      timestamptz          not null default now(),
  completed_at    timestamptz
);
create index eval_runs_suite_id_idx   on public.eval_runs (suite_id);
create index eval_runs_created_at_idx on public.eval_runs (created_at desc);

create table public.judgments (
  id                 uuid             primary key default gen_random_uuid(),
  evaluator_id       text             not null,
  rubric_version     text             not null,
  judge_model        text             not null,
  -- Inline runs set generation_run_id; offline suite runs set eval_run_id/case_id.
  generation_run_id  uuid             references public.generation_runs (id) on delete cascade,
  eval_run_id        uuid             references public.eval_runs (id) on delete cascade,
  case_id            uuid             references public.eval_cases (id) on delete set null,
  -- graph-node pointers: stage_id/item_id/artifact_id/asset_id are loose ids that
  -- may reference inline/offline artifacts (not all are generation_* rows), so they
  -- stay TEXT and are NOT FKs (mirrors the original schema's intent).
  stage_id           text             not null,
  item_id            text,
  artifact_id        text,
  asset_id           text,
  grades             jsonb            not null default '{}'::jsonb,
  verdict            judgment_verdict not null,
  rationale          text             not null,
  recommended_action text,
  evidence_ref       text,
  trigger            judgment_trigger not null,
  cost_usd           double precision not null default 0,
  latency_ms         double precision not null default 0,
  created_at         timestamptz      not null default now()
);
create index judgments_generation_run_id_idx on public.judgments (generation_run_id);
create index judgments_eval_run_id_idx        on public.judgments (eval_run_id);
create index judgments_case_id_idx            on public.judgments (case_id);
create index judgments_stage_id_idx           on public.judgments (stage_id);
create index judgments_artifact_id_idx        on public.judgments (artifact_id);

create table public.expectation_results (
  eval_run_id  uuid        not null references public.eval_runs (id) on delete cascade,
  case_id      uuid        not null,
  judgment_id  uuid        not null references public.judgments (id) on delete cascade,
  matched      boolean     not null,
  detail       text,
  primary key (eval_run_id, judgment_id)
);
create index expectation_results_eval_run_id_idx on public.expectation_results (eval_run_id);

-- ---------------------------------------------------------------------------
-- 9. Row Level Security.
-- ---------------------------------------------------------------------------
-- 9a. Workspaces + membership + invites.
alter table public.workspaces        enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_invites enable row level security;

create policy workspaces_select on public.workspaces
  for select to authenticated
  using (public.is_workspace_member(id));
create policy workspaces_insert on public.workspaces
  for insert to authenticated
  with check (owner_id = public.current_app_user_id());
create policy workspaces_update on public.workspaces
  for update to authenticated
  using (public.is_workspace_admin(id))
  with check (public.is_workspace_admin(id));
create policy workspaces_delete on public.workspaces
  for delete to authenticated
  using (public.is_workspace_admin(id));

create policy workspace_members_select on public.workspace_members
  for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy workspace_members_insert on public.workspace_members
  for insert to authenticated
  with check (public.is_workspace_admin(workspace_id));
create policy workspace_members_update on public.workspace_members
  for update to authenticated
  using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));
create policy workspace_members_delete on public.workspace_members
  for delete to authenticated
  using (public.is_workspace_admin(workspace_id));

create policy workspace_invites_select on public.workspace_invites
  for select to authenticated
  using (public.is_workspace_admin(workspace_id));
create policy workspace_invites_insert on public.workspace_invites
  for insert to authenticated
  with check (public.is_workspace_admin(workspace_id));
create policy workspace_invites_update on public.workspace_invites
  for update to authenticated
  using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));
create policy workspace_invites_delete on public.workspace_invites
  for delete to authenticated
  using (public.is_workspace_admin(workspace_id));

-- 9b. v1 entities (walk back to the owning workspace via membership).
alter table public.projects               enable row level security;
alter table public.brief_versions         enable row level security;
alter table public.assets                 enable row level security;
alter table public.compositions           enable row level security;
alter table public.jobs                   enable row level security;
alter table public.edit_graphs            enable row level security;
alter table public.timelines              enable row level security;
alter table public.generation_runs        enable row level security;
alter table public.generation_stages      enable row level security;
alter table public.generation_stage_items enable row level security;
alter table public.generation_stage_artifacts enable row level security;
alter table public.idempotency            enable row level security;

create policy projects_owner on public.projects
  for all using (public.owns_workspace(workspace_id)) with check (public.owns_workspace(workspace_id));
create policy assets_owner on public.assets
  for all using (public.owns_workspace(workspace_id) and public.owns_project(project_id))
  with check (public.owns_workspace(workspace_id) and public.owns_project(project_id));
create policy jobs_owner on public.jobs
  for all using (public.owns_workspace(workspace_id) and public.owns_project(project_id))
  with check (public.owns_workspace(workspace_id) and public.owns_project(project_id));
create policy brief_versions_owner on public.brief_versions
  for all using (public.owns_project(project_id)) with check (public.owns_project(project_id));
create policy compositions_owner on public.compositions
  for all using (public.owns_project(project_id)) with check (public.owns_project(project_id));
create policy edit_graphs_owner on public.edit_graphs
  for all using (public.owns_project(project_id)) with check (public.owns_project(project_id));
create policy timelines_owner on public.timelines
  for all using (public.owns_project(project_id)) with check (public.owns_project(project_id));
create policy generation_runs_owner on public.generation_runs
  for all using (public.owns_project(project_id)) with check (public.owns_project(project_id));

create policy generation_stages_owner on public.generation_stages
  for all using (
    exists (select 1 from public.generation_runs r
            where r.id = generation_stages.run_id and public.owns_project(r.project_id))
  ) with check (
    exists (select 1 from public.generation_runs r
            where r.id = generation_stages.run_id and public.owns_project(r.project_id))
  );
create policy generation_stage_items_owner on public.generation_stage_items
  for all using (
    exists (select 1 from public.generation_stages s
            join public.generation_runs r on r.id = s.run_id
            where s.id = generation_stage_items.stage_id and public.owns_project(r.project_id))
  ) with check (
    exists (select 1 from public.generation_stages s
            join public.generation_runs r on r.id = s.run_id
            where s.id = generation_stage_items.stage_id and public.owns_project(r.project_id))
  );
create policy generation_stage_artifacts_owner on public.generation_stage_artifacts
  for all using (
    exists (select 1 from public.generation_runs r
            where r.id = generation_stage_artifacts.run_id and public.owns_project(r.project_id))
  ) with check (
    exists (select 1 from public.generation_runs r
            where r.id = generation_stage_artifacts.run_id and public.owns_project(r.project_id))
  );

-- Idempotency: service-role only (RLS on, no policy).

-- 9c. Eval entities — service-role only (RLS on, no end-user policy), and
-- judgments stays append-only (revoke UPDATE/DELETE even for service_role).
alter table public.eval_suites         enable row level security;
alter table public.eval_cases          enable row level security;
alter table public.eval_runs           enable row level security;
alter table public.judgments           enable row level security;
alter table public.expectation_results enable row level security;

-- Inline judgments are reachable through their generation run's project; offline
-- suite judgments (no generation_run_id) remain service-role only.
create policy judgments_owner on public.judgments
  for all using (
    generation_run_id is not null
    and exists (select 1 from public.generation_runs r
                where r.id = judgments.generation_run_id and public.owns_project(r.project_id))
  ) with check (
    generation_run_id is not null
    and exists (select 1 from public.generation_runs r
                where r.id = judgments.generation_run_id and public.owns_project(r.project_id))
  );

revoke update, delete on table public.judgments from public;
