-- User tiers, content visibility, public discovery reads, and saved asset
-- bookmarks for the split Supabase model.
--
-- Identity rule: tier lives on public.users, while all content authorization
-- continues to key through workspace membership and public.current_app_user_id().

create type public.user_tier as enum ('free', 'paid');
create type public.visibility as enum ('public', 'private');

alter table public.users
  add column tier public.user_tier not null default 'free',
  add column tier_source text,
  add column tier_changed_at timestamptz not null default now();

create or replace function public.protect_user_tier_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.tier is distinct from old.tier
    or new.tier_source is distinct from old.tier_source
    or new.tier_changed_at is distinct from old.tier_changed_at then
    if coalesce(auth.role(), '') <> 'service_role' then
      raise exception 'user tier fields may only be updated by service role'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  if new.tier is distinct from old.tier then
    new.tier_changed_at := now();
  end if;

  return new;
end;
$$;

create trigger users_protect_tier_update
  before update of tier, tier_source, tier_changed_at on public.users
  for each row execute function public.protect_user_tier_update();

create or replace function public.owner_tier(ws_id text)
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

revoke all on function public.owner_tier(text) from public;
grant execute on function public.owner_tier(text) to anon, authenticated, service_role;

alter table public.projects
  add column visibility public.visibility not null default 'public';

alter table public.assets
  add column visibility public.visibility not null default 'public',
  add column storage_bucket text;

update public.assets
set storage_bucket = 'assets-private'
where storage_bucket is null and storage_key is not null;

create index projects_visibility_idx
  on public.projects (visibility)
  where visibility = 'public';

create index assets_visibility_idx
  on public.assets (visibility)
  where visibility = 'public';

create index projects_public_feed_idx
  on public.projects (created_at desc)
  where visibility = 'public';

create index assets_public_feed_idx
  on public.assets (created_at desc)
  where visibility = 'public';

create index projects_search_idx
  on public.projects
  using gin (
    to_tsvector(
      'english',
      coalesce(name, '') || ' ' || coalesce(brief ->> 'summary', '')
    )
  )
  where visibility = 'public';

create index assets_search_idx
  on public.assets
  using gin (
    to_tsvector(
      'english',
      coalesce(description, '') || ' ' || coalesce(context ->> 'summary', '')
    )
  )
  where visibility = 'public';

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
  )
$$;

revoke all on function public.project_is_public(text) from public;
grant execute on function public.project_is_public(text) to anon, authenticated, service_role;

create or replace function public.asset_is_effectively_public(asset_id text)
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
    where a.id = asset_id
      and a.visibility = 'public'
      and p.visibility = 'public'
  )
$$;

revoke all on function public.asset_is_effectively_public(text) from public;
grant execute on function public.asset_is_effectively_public(text) to anon, authenticated, service_role;

create or replace function public.generation_run_is_public(p_run_id text)
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
  )
$$;

revoke all on function public.generation_run_is_public(text) from public;
grant execute on function public.generation_run_is_public(text) to anon, authenticated, service_role;

create or replace function public.generation_stage_is_public(p_stage_id text)
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
      and public.generation_run_is_public(s.run_id)
  )
$$;

revoke all on function public.generation_stage_is_public(text) from public;
grant execute on function public.generation_stage_is_public(text) to anon, authenticated, service_role;

create policy projects_public_read on public.projects
  for select to anon, authenticated
  using (visibility = 'public');

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

create or replace function public.enforce_project_visibility_tier()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.visibility = 'private'
    and public.owner_tier(new.workspace_id) = 'free' then
    raise exception 'free tier cannot make content private (workspace %)', new.workspace_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger projects_visibility_tier
  before insert or update of visibility, workspace_id on public.projects
  for each row execute function public.enforce_project_visibility_tier();

create or replace function public.enforce_asset_visibility_tier()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.visibility = 'private'
    and public.owner_tier(new.workspace_id) = 'free' then
    raise exception 'free tier cannot make content private (workspace %)', new.workspace_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger assets_visibility_tier
  before insert or update of visibility, workspace_id on public.assets
  for each row execute function public.enforce_asset_visibility_tier();

create table public.saved_assets (
  user_id uuid not null references public.users (id) on delete cascade,
  source_asset_id text not null references public.assets (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, source_asset_id)
);

alter table public.saved_assets enable row level security;

create policy saved_assets_select_own on public.saved_assets
  for select to authenticated
  using (user_id = public.current_app_user_id());

create policy saved_assets_insert_own on public.saved_assets
  for insert to authenticated
  with check (
    user_id = public.current_app_user_id()
    and public.asset_is_effectively_public(source_asset_id)
  );

create policy saved_assets_delete_own on public.saved_assets
  for delete to authenticated
  using (user_id = public.current_app_user_id());
