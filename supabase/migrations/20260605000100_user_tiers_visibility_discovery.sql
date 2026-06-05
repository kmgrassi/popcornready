-- User tiers, content visibility, and public discovery indexes.
--
-- Implements the data-model prerequisites through discovery feed/search indexes
-- from docs/scopes/user-tiers-content-visibility.md. The saved_assets bookmark
-- table is intentionally left to the following slice.

create type user_tier as enum ('free', 'paid');
create type visibility as enum ('public', 'private');

alter table public.users
  add column tier user_tier not null default 'free',
  add column tier_source text,
  add column tier_changed_at timestamptz not null default now();

alter table public.projects
  add column visibility visibility not null default 'public';

alter table public.assets
  add column visibility visibility not null default 'public',
  add column storage_bucket text;

update public.assets
set storage_bucket = 'assets-private'
where storage_bucket is null
  and storage_key is not null;

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
  where w.id = ws_id
$$;

revoke all on function public.owner_tier(text) from public;
grant execute on function public.owner_tier(text) to anon, authenticated, service_role;

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
      and p.status <> 'deleted'
  )
$$;

revoke all on function public.project_is_public(text) from public;
grant execute on function public.project_is_public(text) to anon, authenticated, service_role;

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

create policy edit_graphs_public_read on public.edit_graphs
  for select to anon, authenticated
  using (public.project_is_public(project_id));

create policy timelines_public_read on public.timelines
  for select to anon, authenticated
  using (public.project_is_public(project_id));

create policy generation_runs_public_read on public.generation_runs
  for select to anon, authenticated
  using (public.project_is_public(project_id));

create policy jobs_public_read on public.jobs
  for select to anon, authenticated
  using (public.project_is_public(project_id));

create or replace function public.generation_stage_project_is_public(stage_run_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.generation_runs r
    where r.run_id = stage_run_id
      and public.project_is_public(r.project_id)
  )
$$;

revoke all on function public.generation_stage_project_is_public(text) from public;
grant execute on function public.generation_stage_project_is_public(text) to anon, authenticated, service_role;

create policy generation_stages_public_read on public.generation_stages
  for select to anon, authenticated
  using (public.generation_stage_project_is_public(run_id));

create or replace function public.generation_stage_item_project_is_public(item_stage_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.generation_stages s
    join public.generation_runs r on r.run_id = s.run_id
    where s.stage_id = item_stage_id
      and public.project_is_public(r.project_id)
  )
$$;

revoke all on function public.generation_stage_item_project_is_public(text) from public;
grant execute on function public.generation_stage_item_project_is_public(text) to anon, authenticated, service_role;

create policy generation_stage_items_public_read on public.generation_stage_items
  for select to anon, authenticated
  using (public.generation_stage_item_project_is_public(stage_id));

create or replace function public.enforce_visibility_tier()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  ws_id text;
begin
  ws_id := new.workspace_id;

  if public.owner_tier(ws_id) = 'free' and new.visibility = 'private' then
    raise exception 'free tier cannot make content private (workspace %)', ws_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_visibility_tier() from public;
grant execute on function public.enforce_visibility_tier() to service_role;

create trigger projects_visibility_tier
  before insert or update of visibility, workspace_id on public.projects
  for each row execute function public.enforce_visibility_tier();

create trigger assets_visibility_tier
  before insert or update of visibility, workspace_id on public.assets
  for each row execute function public.enforce_visibility_tier();

create index projects_visibility_idx
  on public.projects (visibility)
  where visibility = 'public';

create index assets_visibility_idx
  on public.assets (visibility)
  where visibility = 'public';

create index projects_public_feed_idx
  on public.projects (created_at desc, id desc)
  where visibility = 'public' and status <> 'deleted';

create index assets_public_feed_idx
  on public.assets (created_at desc, id desc)
  where visibility = 'public';

create index projects_search_idx
  on public.projects
  using gin (
    to_tsvector(
      'english',
      coalesce(name, '') || ' ' ||
      coalesce(brief ->> 'summary', '') || ' ' ||
      coalesce(brief ->> 'goal', '')
    )
  )
  where visibility = 'public' and status <> 'deleted';

create index assets_search_idx
  on public.assets
  using gin (
    to_tsvector(
      'english',
      coalesce(description, '') || ' ' ||
      coalesce(context ->> 'summary', '') || ' ' ||
      coalesce(context #>> '{context,summary}', '') || ' ' ||
      coalesce(context #>> '{agentContext,summary}', '') || ' ' ||
      coalesce(context #>> '{clipUnderstanding,combinedSummary}', '') || ' ' ||
      coalesce(context #>> '{context,transcriptText}', '') || ' ' ||
      coalesce(semantic_analysis::text, '')
    )
  )
  where visibility = 'public';

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
grant execute on function public.search_public_projects(text) to anon, authenticated, service_role;

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
