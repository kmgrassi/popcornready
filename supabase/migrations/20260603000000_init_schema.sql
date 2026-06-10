-- Popcorn Ready — consolidated initial schema (v1 model + eval + tiers/visibility).
--
-- This single migration is the squashed, conflict-free replacement for the
-- original June 3–5 migration set, which had accumulated several parallel,
-- agent-generated drafts with COLLIDING timestamps and contradictory
-- definitions (two `judgments` tables, a destructive uuid-PK "reset", and four
-- overlapping tier/visibility implementations written against the pre-uuid
-- text-PK schema). That set could not apply cleanly — `supabase db push` failed
-- with `relation "judgments" already exists`.
--
-- The final intended state captured here:
--   * DB-generated UUID primary keys everywhere (app no longer mints ids).
--   * public.users decoupled from auth.users (auth_id link + signup mirror).
--   * Full v1 data model (workspaces/projects/assets/compositions/jobs/
--     timelines/edit_graphs + generation runs/stages/items/artifacts).
--   * Eval framework (suites/cases/runs/judgments/expectation_results), with a
--     single reconciled `judgments` table covering inline + offline provenance.
--   * User tiers + public/private content visibility, public-read RLS, DB-side
--     tier→visibility enforcement, discovery search RPCs, saved-asset bookmarks.
--
-- Identity & RLS conventions: docs/supabase-identity-and-rls.md + supabase/README.md.
-- Because this rewrites the migration history, the linked dev database must be
-- reset (`supabase db reset --linked`) so it re-applies from this baseline.

set check_function_bodies = off;

create extension if not exists pgcrypto;

-- ===========================================================================
-- 0. Enums
-- ===========================================================================
-- v1 model (mirror the TS string unions).
create type project_status        as enum ('active', 'deleted');
create type asset_kind            as enum ('video', 'image', 'audio');
create type asset_status          as enum ('pending', 'processing', 'ready', 'failed');
create type composition_mode      as enum ('asset_driven', 'prompt_only', 'hybrid');
create type composition_status    as enum ('planning', 'generating_assets', 'ready_for_timeline', 'failed');
create type job_type              as enum ('asset_ingest', 'asset_generation', 'composition', 'generation', 'revision', 'export', 'audio_alignment');
create type job_status            as enum ('queued', 'running', 'succeeded', 'failed', 'canceled');
create type generation_stage_type as enum ('brief_intake', 'creative_plan', 'storyboard', 'asset_generation', 'audio_generation', 'timeline_assembly', 'quality_review', 'export', 'ready');
create type stage_item_kind       as enum ('image', 'video', 'audio', 'caption', 'timeline', 'export');

-- eval framework.
create type eval_run_source      as enum ('suite', 'manual_workbench');
create type eval_generation_mode as enum ('prompts_only', 'full');
create type eval_run_status      as enum ('queued', 'running', 'succeeded', 'failed');
create type judgment_verdict     as enum ('pass', 'needs_review', 'fail');
create type judgment_trigger     as enum ('auto', 'manual');

-- tiers / content visibility.
create type public.user_tier  as enum ('free', 'paid');
create type public.visibility as enum ('public', 'private');

-- ===========================================================================
-- 1. Domain users (decoupled from auth.users) + shared helpers.
-- ===========================================================================
-- public.users.id is the app/domain user id; auth_id links to auth.users and is
-- NULL until signup (lets us pre-create invited users). RLS resolves
-- auth.uid() -> public.users.id via current_app_user_id().
create table public.users (
  id              uuid primary key default gen_random_uuid(),
  auth_id         uuid unique references auth.users (id) on delete set null,
  email           text,
  full_name       text,
  first_name      text,
  last_name       text,
  avatar_url      text,
  metadata        jsonb         not null default '{}'::jsonb,
  -- Tier metadata (changed only by trusted server roles; see guard trigger).
  tier            public.user_tier not null default 'free',
  tier_source     text,
  tier_changed_at timestamptz   not null default now(),
  created_at      timestamptz   not null default now(),
  updated_at      timestamptz   not null default now()
);

-- One unlinked (pre-auth) row per email so the signup trigger can link unambiguously.
create unique index users_unique_unlinked_email
  on public.users (lower(btrim(email)))
  where auth_id is null and email is not null and btrim(email) <> '';

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger users_set_updated_at
  before update on public.users
  for each row execute function public.set_updated_at();

-- auth.uid() -> public.users.id. SECURITY DEFINER so RLS policies on other tables
-- can call it without recursing through public.users' own RLS.
create or replace function public.current_app_user_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.users where auth_id = auth.uid() limit 1
$$;
revoke all on function public.current_app_user_id() from public;
grant execute on function public.current_app_user_id() to authenticated, service_role;

-- auth.users -> public.users mirror / link on signup.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_first_name text := new.raw_user_meta_data ->> 'first_name';
  v_last_name  text := new.raw_user_meta_data ->> 'last_name';
  v_full_name  text := nullif(btrim(concat_ws(' ', v_first_name, v_last_name)), '');
  v_email      text := coalesce(new.email, new.raw_user_meta_data ->> 'email');
  v_existing   uuid;
begin
  if nullif(v_email, '') is not null then
    select id into v_existing
    from public.users
    where auth_id is null
      and lower(btrim(email)) = lower(btrim(v_email));
  end if;

  if v_existing is not null then
    update public.users set
      auth_id    = new.id,
      first_name = coalesce(first_name, nullif(v_first_name, '')),
      last_name  = coalesce(last_name,  nullif(v_last_name, '')),
      full_name  = coalesce(full_name,  v_full_name),
      avatar_url = coalesce(avatar_url, new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture'),
      metadata   = metadata || coalesce(new.raw_user_meta_data, '{}'::jsonb)
    where id = v_existing;
  else
    insert into public.users (auth_id, email, full_name, first_name, last_name, avatar_url, metadata)
    values (
      new.id,
      v_email,
      coalesce(v_full_name, new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
      v_first_name,
      v_last_name,
      coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture'),
      coalesce(new.raw_user_meta_data, '{}'::jsonb)
    );
  end if;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Tier fields are server-owned: block changes from anon/authenticated, and bump
-- tier_changed_at whenever the tier actually changes.
create or replace function public.guard_user_tier_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (
    new.tier is distinct from old.tier
    or new.tier_source is distinct from old.tier_source
    or new.tier_changed_at is distinct from old.tier_changed_at
  ) and coalesce(auth.role(), '') <> 'service_role'
    and current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'user tier fields can only be changed by trusted server roles'
      using errcode = 'insufficient_privilege';
  end if;

  if new.tier is distinct from old.tier then
    new.tier_changed_at := now();
  end if;

  return new;
end;
$$;

create trigger users_guard_tier_update
  before update of tier, tier_source, tier_changed_at on public.users
  for each row execute function public.guard_user_tier_update();

-- RLS: a signed-in user reads/updates only their own linked row. Pre-auth (invite)
-- rows have auth_id NULL and are managed server-side via the service_role.
alter table public.users enable row level security;

create policy users_select_own on public.users
  for select to authenticated
  using (auth_id = auth.uid());

create policy users_update_own on public.users
  for update to authenticated
  using (auth_id = auth.uid())
  with check (auth_id = auth.uid());

-- owner_tier: the tier of the user owning a workspace ('free' when unowned/missing).
create or replace function public.owner_tier(ws_id uuid)
returns public.user_tier
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(u.tier, 'free'::public.user_tier)
  from public.workspaces w
  left join public.users u on u.id = w.owner_id
  where w.id = ws_id
$$;
revoke all on function public.owner_tier(uuid) from public;
grant execute on function public.owner_tier(uuid) to anon, authenticated, service_role;

-- ===========================================================================
-- 2. Storage buckets (private; server reads/writes via service_role).
-- ===========================================================================
insert into storage.buckets (id, name, public)
values ('assets', 'assets', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('eval', 'eval', false)
on conflict (id) do nothing;

-- ===========================================================================
-- 3. Workspaces + membership + invites.
-- ===========================================================================
create table public.workspaces (
  id             uuid primary key default gen_random_uuid(),
  schema_version text        not null default 'workspace.v1',
  -- Domain user (public.users.id) that owns this workspace; null for the seeded
  -- local dev workspace.
  owner_id       uuid        references public.users (id) on delete set null,
  name           text        not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Natural-key uniqueness backing find-or-create (app no longer mints ids):
--   * One workspace per owning domain user.
--   * One unowned local dev workspace per name.
create unique index workspaces_unique_owner
  on public.workspaces (owner_id)
  where owner_id is not null;
create unique index workspaces_unique_local_name
  on public.workspaces (lower(name))
  where owner_id is null;

create trigger workspaces_set_updated_at
  before update on public.workspaces
  for each row execute function public.set_updated_at();

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

create table public.workspace_invites (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  email         text not null check (btrim(email) <> ''),
  role          text not null default 'member' check (role in ('owner', 'admin', 'member')),
  invited_by    uuid references public.users (id) on delete set null,
  -- 64-char hex token from two core gen_random_uuid()s (~244 bits of entropy).
  -- Avoids pgcrypto's gen_random_bytes, which on Supabase lives in the
  -- `extensions` schema and is not on the search_path at migration time.
  token         text not null unique
                  default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
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

-- --- membership / ownership helpers ----------------------------------------
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

-- --- invite accept/expire flows --------------------------------------------
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

-- ===========================================================================
-- 4. Projects / briefs / assets (+ content visibility metadata).
-- ===========================================================================
create table public.projects (
  id                       uuid primary key default gen_random_uuid(),
  schema_version           text          not null default 'project.v1',
  workspace_id             uuid          not null references public.workspaces (id) on delete cascade,
  name                     text          not null,
  status                   project_status not null default 'active',
  brief                    jsonb,
  current_brief_version_id uuid,
  visibility               public.visibility not null default 'public',
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
  storage_bucket           text,
  source                   jsonb       not null,
  duration_sec             double precision,
  description              text,
  context                  jsonb,
  semantic_analysis        jsonb,
  provenance               jsonb,
  generated_asset_job_id   uuid,
  visibility               public.visibility not null default 'public',
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create index assets_project_id_idx   on public.assets (project_id);
create index assets_workspace_id_idx on public.assets (workspace_id);

comment on column public.projects.visibility is
  'Public/private discovery visibility. Free-owner content is forced public by the tier enforcement trigger.';
comment on column public.assets.visibility is
  'Asset-level public/private visibility. Effective public access also requires the owning project to be public.';
comment on column public.assets.storage_bucket is
  'Physical object bucket for delivery (tracks effective visibility once the S3/CloudFront storage toggle is wired).';

-- ===========================================================================
-- 5. Composition / jobs / timeline / edit graph.
-- ===========================================================================
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
  -- Full EditGraphDocument; its internal node ids live INSIDE this jsonb and are
  -- app-generated (in-JSON keys are exempt from the DB-generated-uuid rule).
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

-- ===========================================================================
-- 6. Generation runs / stages / items / artifacts.
-- ===========================================================================
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
  -- Loose uuid (no FK): may point at an artifact created in a separate write or
  -- an inline/offline artifact that is not a generation_stage_artifacts row.
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

-- ===========================================================================
-- 7. Idempotency (composite (scope, key) PK).
-- ===========================================================================
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

-- ===========================================================================
-- 8. Eval entities (global admin/tooling records; service-role only).
-- ===========================================================================
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

-- Single reconciled judgments table: inline runs set generation_run_id; offline
-- suite runs set eval_run_id/case_id. Append-only (UPDATE/DELETE revoked below).
create table public.judgments (
  id                 uuid             primary key default gen_random_uuid(),
  evaluator_id       text             not null,
  rubric_version     text             not null,
  judge_model        text             not null,
  generation_run_id  uuid             references public.generation_runs (id) on delete cascade,
  eval_run_id        uuid             references public.eval_runs (id) on delete cascade,
  case_id            uuid             references public.eval_cases (id) on delete set null,
  -- graph-node pointers: loose ids that may reference inline/offline artifacts
  -- (not all are generation_* rows), so they stay TEXT and are NOT FKs.
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

-- ===========================================================================
-- 9. Row Level Security — owner (membership) policies.
-- ===========================================================================
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

alter table public.projects                   enable row level security;
alter table public.brief_versions             enable row level security;
alter table public.assets                     enable row level security;
alter table public.compositions               enable row level security;
alter table public.jobs                       enable row level security;
alter table public.edit_graphs                enable row level security;
alter table public.timelines                  enable row level security;
alter table public.generation_runs            enable row level security;
alter table public.generation_stages          enable row level security;
alter table public.generation_stage_items     enable row level security;
alter table public.generation_stage_artifacts enable row level security;
alter table public.idempotency                enable row level security;

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

-- Eval entities: service-role only (RLS on, no end-user policy); judgments stays
-- append-only (revoke UPDATE/DELETE even for the service_role path).
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

-- ===========================================================================
-- 10. Public discovery — visibility helpers, indexes, public-read RLS.
-- ===========================================================================
create or replace function public.project_is_public(proj_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.projects p
    where p.id = proj_id
      and p.visibility = 'public'
      and p.status <> 'deleted'
  )
$$;
revoke all on function public.project_is_public(uuid) from public;
grant execute on function public.project_is_public(uuid) to anon, authenticated, service_role;

create or replace function public.asset_is_effectively_public(p_asset_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.assets a
    join public.projects p on p.id = a.project_id
    where a.id = p_asset_id
      and a.visibility = 'public'
      and p.visibility = 'public'
      and p.status <> 'deleted'
  )
$$;
revoke all on function public.asset_is_effectively_public(uuid) from public;
grant execute on function public.asset_is_effectively_public(uuid) to anon, authenticated, service_role;

create or replace function public.generation_run_is_public(p_run_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.generation_runs r
    where r.id = p_run_id
      and public.project_is_public(r.project_id)
  )
$$;
revoke all on function public.generation_run_is_public(uuid) from public;
grant execute on function public.generation_run_is_public(uuid) to anon, authenticated, service_role;

create or replace function public.generation_stage_is_public(p_stage_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.generation_stages s
    where s.id = p_stage_id
      and public.generation_run_is_public(s.run_id)
  )
$$;
revoke all on function public.generation_stage_is_public(uuid) from public;
grant execute on function public.generation_stage_is_public(uuid) to anon, authenticated, service_role;

-- Discovery indexes (partial: only public, non-deleted content).
create index projects_visibility_idx on public.projects (visibility)
  where visibility = 'public' and status <> 'deleted';
create index assets_visibility_idx on public.assets (visibility)
  where visibility = 'public';
create index projects_public_feed_idx on public.projects (created_at desc)
  where visibility = 'public' and status <> 'deleted';
create index assets_public_feed_idx on public.assets (created_at desc)
  where visibility = 'public';
create index projects_search_idx on public.projects
  using gin (to_tsvector('english', coalesce(name, '') || ' ' || coalesce(brief ->> 'summary', '')))
  where visibility = 'public' and status <> 'deleted';
create index assets_search_idx on public.assets
  using gin (to_tsvector('english', coalesce(description, '') || ' ' || coalesce(context ->> 'summary', '')))
  where visibility = 'public';

create policy projects_public_read on public.projects
  for select to anon, authenticated
  using (visibility = 'public' and status <> 'deleted');
create policy assets_public_read on public.assets
  for select to anon, authenticated
  using (visibility = 'public' and public.project_is_public(project_id));
create policy brief_versions_public_read on public.brief_versions
  for select to anon, authenticated
  using (public.project_is_public(project_id));
create policy compositions_public_read on public.compositions
  for select to anon, authenticated
  using (public.project_is_public(project_id));
create policy jobs_public_read on public.jobs
  for select to anon, authenticated
  using (public.project_is_public(project_id));
create policy edit_graphs_public_read on public.edit_graphs
  for select to anon, authenticated
  using (public.project_is_public(project_id));
create policy timelines_public_read on public.timelines
  for select to anon, authenticated
  using (public.project_is_public(project_id));
create policy generation_runs_public_read on public.generation_runs
  for select to anon, authenticated
  using (public.project_is_public(project_id));
create policy generation_stages_public_read on public.generation_stages
  for select to anon, authenticated
  using (public.generation_run_is_public(run_id));
create policy generation_stage_items_public_read on public.generation_stage_items
  for select to anon, authenticated
  using (public.generation_stage_is_public(stage_id));
create policy generation_stage_artifacts_public_read on public.generation_stage_artifacts
  for select to anon, authenticated
  using (public.generation_run_is_public(run_id));
create policy judgments_public_read on public.judgments
  for select to anon, authenticated
  using (
    generation_run_id is not null
    and public.generation_run_is_public(generation_run_id)
  );

-- ===========================================================================
-- 11. Tier -> visibility enforcement (free-owned content cannot be private).
-- ===========================================================================
create or replace function public.enforce_visibility_tier()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_workspace_id uuid;
begin
  if tg_table_name = 'assets' then
    select p.workspace_id into target_workspace_id
    from public.projects p
    where p.id = new.project_id;

    if target_workspace_id is null then
      raise exception 'asset project does not exist (%)', new.project_id
        using errcode = 'foreign_key_violation';
    end if;

    if new.workspace_id is distinct from target_workspace_id then
      raise exception 'asset workspace % does not match project % workspace %',
        new.workspace_id, new.project_id, target_workspace_id
        using errcode = 'check_violation';
    end if;
  else
    target_workspace_id := new.workspace_id;
  end if;

  if new.visibility = 'private'
     and public.owner_tier(target_workspace_id) = 'free'::public.user_tier then
    raise exception 'free tier cannot make content private (workspace %)', target_workspace_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger projects_visibility_tier
  before insert or update of visibility, workspace_id on public.projects
  for each row execute function public.enforce_visibility_tier();

create trigger assets_visibility_tier
  before insert or update of visibility, workspace_id, project_id on public.assets
  for each row execute function public.enforce_visibility_tier();

-- ===========================================================================
-- 12. Public discovery search RPCs (SECURITY DEFINER; bypass RLS by design).
-- ===========================================================================
create or replace function public.search_public_projects(search_query text)
returns setof public.projects
language sql
stable
security definer
set search_path = public
as $$
  select p.*
  from public.projects p
  where p.visibility = 'public'
    and p.status <> 'deleted'
    and to_tsvector(
      'english',
      coalesce(p.name, '') || ' ' ||
      coalesce(p.brief ->> 'summary', '') || ' ' ||
      coalesce(p.brief ->> 'goal', '')
    ) @@ plainto_tsquery('english', search_query)
  order by p.created_at desc, p.id desc
$$;
revoke all on function public.search_public_projects(text) from public;
grant execute on function public.search_public_projects(text)
  to anon, authenticated, service_role;

create or replace function public.search_public_assets(
  search_query text,
  asset_kind_filter public.asset_kind default null
)
returns setof public.assets
language sql
stable
security definer
set search_path = public
as $$
  select a.*
  from public.assets a
  join public.projects p on p.id = a.project_id
  where a.visibility = 'public'
    and p.visibility = 'public'
    and p.status <> 'deleted'
    and (asset_kind_filter is null or a.kind = asset_kind_filter)
    and to_tsvector(
      'english',
      coalesce(a.description, '') || ' ' ||
      coalesce(a.context ->> 'summary', '') || ' ' ||
      coalesce(a.context #>> '{context,summary}', '') || ' ' ||
      coalesce(a.context #>> '{agentContext,summary}', '') || ' ' ||
      coalesce(a.context #>> '{clipUnderstanding,combinedSummary}', '') || ' ' ||
      coalesce(a.context #>> '{context,transcriptText}', '') || ' ' ||
      coalesce(a.semantic_analysis::text, '')
    ) @@ plainto_tsquery('english', search_query)
  order by a.created_at desc, a.id desc
$$;
revoke all on function public.search_public_assets(text, public.asset_kind) from public;
grant execute on function public.search_public_assets(text, public.asset_kind)
  to anon, authenticated, service_role;

-- ===========================================================================
-- 13. Saved public-asset bookmarks (thin user-owned pointers; no byte copy).
-- ===========================================================================
create table public.saved_assets (
  user_id         uuid not null references public.users (id) on delete cascade,
  source_asset_id uuid not null references public.assets (id) on delete cascade,
  created_at      timestamptz not null default now(),
  primary key (user_id, source_asset_id)
);
create index saved_assets_source_asset_id_idx on public.saved_assets (source_asset_id);

alter table public.saved_assets enable row level security;

create policy saved_assets_select_own on public.saved_assets
  for select to authenticated
  using (user_id = public.current_app_user_id());

-- Bookmarks may only be created for assets that are effectively public.
create policy saved_assets_insert_own on public.saved_assets
  for insert to authenticated
  with check (
    user_id = public.current_app_user_id()
    and public.asset_is_effectively_public(source_asset_id)
  );

create policy saved_assets_delete_own on public.saved_assets
  for delete to authenticated
  using (user_id = public.current_app_user_id());
