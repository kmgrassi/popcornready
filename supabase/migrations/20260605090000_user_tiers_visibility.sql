-- User tiers + public/private visibility foundation.
--
-- Implements docs/scopes/user-tiers-content-visibility.md PR 1:
--   * user tier metadata on public.users
--   * project/asset visibility metadata and public-read RLS
--   * DB-side tier -> visibility enforcement
--   * public discovery/search indexes
--   * saved asset bookmarks

set check_function_bodies = off;

-- ---------------------------------------------------------------------------
-- Tiers
-- ---------------------------------------------------------------------------
create type public.user_tier as enum ('free', 'paid');

alter table public.users
  add column tier public.user_tier not null default 'free',
  add column tier_source text,
  add column tier_changed_at timestamptz not null default now();

create or replace function public.guard_user_tier_update()
returns trigger
language plpgsql
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

create or replace function public.owner_tier(ws_id text)
returns public.user_tier
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select u.tier
      from public.workspaces w
      left join public.users u on u.id = w.owner_id
      where w.id = ws_id
      limit 1
    ),
    'free'::public.user_tier
  );
$$;

revoke all on function public.owner_tier(text) from public;
grant execute on function public.owner_tier(text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Visibility metadata
-- ---------------------------------------------------------------------------
create type public.visibility as enum ('public', 'private');

alter table public.projects
  add column visibility public.visibility not null default 'public';

alter table public.assets
  add column visibility public.visibility not null default 'public',
  add column storage_bucket text default 'assets-private';

update public.assets
set storage_bucket = 'assets-private'
where storage_bucket is null;

create index projects_visibility_idx on public.projects (visibility)
  where visibility = 'public' and status = 'active';
create index assets_visibility_idx on public.assets (visibility)
  where visibility = 'public';

create index projects_public_feed_idx on public.projects (created_at desc)
  where visibility = 'public' and status = 'active';
create index assets_public_feed_idx on public.assets (created_at desc)
  where visibility = 'public';

create index projects_search_idx on public.projects
  using gin (
    to_tsvector(
      'english',
      coalesce(name, '') || ' ' || coalesce(brief ->> 'summary', '')
    )
  )
  where visibility = 'public' and status = 'active';

create index assets_search_idx on public.assets
  using gin (
    to_tsvector(
      'english',
      coalesce(description, '') || ' ' || coalesce(context ->> 'summary', '')
    )
  )
  where visibility = 'public';

-- ---------------------------------------------------------------------------
-- Public-read helpers and policies
-- ---------------------------------------------------------------------------
create or replace function public.project_is_public(proj_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.projects p
    where p.id = proj_id
      and p.visibility = 'public'
      and p.status = 'active'
  );
$$;

revoke all on function public.project_is_public(text) from public;
grant execute on function public.project_is_public(text) to anon, authenticated, service_role;

create or replace function public.generation_run_project_is_public(p_run_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.generation_runs r
    where r.run_id = p_run_id
      and public.project_is_public(r.project_id)
  );
$$;

revoke all on function public.generation_run_project_is_public(text) from public;
grant execute on function public.generation_run_project_is_public(text) to anon, authenticated, service_role;

create or replace function public.generation_stage_project_is_public(p_stage_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.generation_stages s
    where s.stage_id = p_stage_id
      and public.generation_run_project_is_public(s.run_id)
  );
$$;

revoke all on function public.generation_stage_project_is_public(text) from public;
grant execute on function public.generation_stage_project_is_public(text) to anon, authenticated, service_role;

create policy projects_public_read on public.projects
  for select to anon, authenticated
  using (visibility = 'public' and status = 'active');

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
  using (public.generation_run_project_is_public(run_id));

create policy generation_stage_items_public_read on public.generation_stage_items
  for select to anon, authenticated
  using (public.generation_stage_project_is_public(stage_id));

create policy generation_stage_artifacts_public_read on public.generation_stage_artifacts
  for select to anon, authenticated
  using (public.generation_run_project_is_public(run_id));

create policy judgments_public_read on public.judgments
  for select to anon, authenticated
  using (
    generation_run_id is not null
    and public.generation_run_project_is_public(generation_run_id)
  );

-- ---------------------------------------------------------------------------
-- Tier -> visibility enforcement
-- ---------------------------------------------------------------------------
create or replace function public.enforce_visibility_tier()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.owner_tier(new.workspace_id) = 'free'
    and new.visibility = 'private'
    and (
      tg_op = 'INSERT'
      or old.visibility is distinct from 'private'
      or old.workspace_id is distinct from new.workspace_id
    ) then
    raise exception 'free tier cannot make content private (workspace %)', new.workspace_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger projects_visibility_tier
  before insert or update of visibility, workspace_id on public.projects
  for each row execute function public.enforce_visibility_tier();

create trigger assets_visibility_tier
  before insert or update of visibility, workspace_id on public.assets
  for each row execute function public.enforce_visibility_tier();

-- ---------------------------------------------------------------------------
-- Saved public asset bookmarks
-- ---------------------------------------------------------------------------
create table public.saved_assets (
  user_id uuid not null references public.users (id) on delete cascade,
  source_asset_id text not null references public.assets (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, source_asset_id)
);

create index saved_assets_source_asset_id_idx on public.saved_assets (source_asset_id);

alter table public.saved_assets enable row level security;

create policy saved_assets_own on public.saved_assets
  for all to authenticated
  using (user_id = public.current_app_user_id())
  with check (user_id = public.current_app_user_id());
