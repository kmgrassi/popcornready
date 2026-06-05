-- User tiers + public visibility read foundation.
--
-- Implements the public-read slice from
-- docs/scopes/user-tiers-content-visibility.md:
--   * tier/visibility primitives needed by the policies
--   * project_is_public() helper
--   * anon/authenticated SELECT policies for public projects and their
--     project-scoped descendants
--
-- Tier enforcement, discovery endpoints, saved_assets, and cross-bucket storage
-- moves are intentionally left to later implementation PRs.

set check_function_bodies = off;

-- ---------------------------------------------------------------------------
-- Tier + visibility primitives
-- ---------------------------------------------------------------------------
create type public.user_tier as enum ('free', 'paid');
create type public.visibility as enum ('public', 'private');

alter table public.users
  add column tier user_tier not null default 'free',
  add column tier_source text,
  add column tier_changed_at timestamptz not null default now();

create or replace function public.protect_user_tier_fields()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (
    old.tier is distinct from new.tier
    or old.tier_source is distinct from new.tier_source
    or old.tier_changed_at is distinct from new.tier_changed_at
  ) and coalesce(auth.role(), '') <> 'service_role'
    and current_user not in ('postgres', 'supabase_admin')
  then
    raise exception 'tier fields can only be changed by trusted server code'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

create trigger users_protect_tier_fields
  before update of tier, tier_source, tier_changed_at on public.users
  for each row execute function public.protect_user_tier_fields();

create or replace function public.owner_tier(ws_id text)
returns user_tier
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(u.tier, 'free'::public.user_tier)
  from public.workspaces w
  left join public.users u on u.id = w.owner_id
  where w.id = ws_id;
$$;

revoke all on function public.owner_tier(text) from public;
grant execute on function public.owner_tier(text) to anon, authenticated, service_role;

alter table public.projects
  add column visibility visibility not null default 'public';

alter table public.assets
  add column visibility visibility not null default 'public',
  add column storage_bucket text;

create index projects_visibility_idx
  on public.projects (visibility)
  where visibility = 'public';

create index assets_visibility_idx
  on public.assets (visibility)
  where visibility = 'public';

-- Feed/search indexes used by discovery read paths.
create index projects_public_feed_idx
  on public.projects (created_at desc)
  where visibility = 'public';

create index assets_public_feed_idx
  on public.assets (created_at desc)
  where visibility = 'public';

create index projects_search_idx
  on public.projects
  using gin (to_tsvector('english', coalesce(name, '') || ' ' || coalesce(brief->>'summary', '')))
  where visibility = 'public';

create index assets_search_idx
  on public.assets
  using gin (to_tsvector('english', coalesce(description, '') || ' ' || coalesce(context->>'summary', '')))
  where visibility = 'public';

-- ---------------------------------------------------------------------------
-- Public visibility helper
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
      and p.status = 'active'
      and p.visibility = 'public'
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

-- ---------------------------------------------------------------------------
-- Public read policies
-- ---------------------------------------------------------------------------
create policy projects_public_read on public.projects
  for select to anon, authenticated
  using (status = 'active' and visibility = 'public');

create policy assets_public_read on public.assets
  for select to anon, authenticated
  using (visibility = 'public' and public.project_is_public(project_id));

create policy brief_versions_public_read on public.brief_versions
  for select to anon, authenticated
  using (public.project_is_public(project_id));

create policy compositions_public_read on public.compositions
  for select to anon, authenticated
  using (public.project_is_public(project_id));

create policy edit_graphs_public_read on public.edit_graphs
  for select to anon, authenticated
  using (public.project_is_public(project_id));

create policy timelines_public_read on public.timelines
  for select to anon, authenticated
  using (public.project_is_public(project_id));

create policy jobs_public_read on public.jobs
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
