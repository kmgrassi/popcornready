-- User tiers + content visibility enforcement.
--
-- Implements the database-owned tier/visibility gate from
-- docs/scopes/user-tiers-content-visibility.md. The trigger rejects attempts to
-- acquire privacy in free-owned workspaces while preserving downgrade semantics:
-- existing private rows remain private if an owner later moves from paid to free.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'user_tier') then
    create type public.user_tier as enum ('free', 'paid');
  end if;
end
$$;

alter table public.users
  add column if not exists tier public.user_tier not null default 'free',
  add column if not exists tier_source text,
  add column if not exists tier_changed_at timestamptz not null default now();

create or replace function public.enforce_user_tier_admin_update()
returns trigger
language plpgsql
as $$
declare
  jwt_role text := current_setting('request.jwt.claim.role', true);
begin
  if jwt_role in ('anon', 'authenticated')
     and (
       new.tier is distinct from old.tier
       or new.tier_source is distinct from old.tier_source
       or new.tier_changed_at is distinct from old.tier_changed_at
     ) then
    raise exception 'tier metadata can only be changed by trusted server code'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

drop trigger if exists users_enforce_tier_admin_update on public.users;
create trigger users_enforce_tier_admin_update
  before update of tier, tier_source, tier_changed_at on public.users
  for each row execute function public.enforce_user_tier_admin_update();

create or replace function public.set_user_tier_changed_at()
returns trigger
language plpgsql
as $$
begin
  if new.tier is distinct from old.tier then
    new.tier_changed_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists users_set_tier_changed_at on public.users;
create trigger users_set_tier_changed_at
  before update of tier on public.users
  for each row execute function public.set_user_tier_changed_at();

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
grant execute on function public.owner_tier(text) to authenticated, service_role;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'visibility') then
    create type public.visibility as enum ('public', 'private');
  end if;
end
$$;

alter table public.projects
  add column if not exists visibility public.visibility not null default 'public';

alter table public.assets
  add column if not exists visibility public.visibility not null default 'public',
  add column if not exists storage_bucket text;

create index if not exists projects_visibility_idx
  on public.projects (visibility)
  where visibility = 'public';

create index if not exists assets_visibility_idx
  on public.assets (visibility)
  where visibility = 'public';

create or replace function public.enforce_visibility_tier()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_workspace_id text;
begin
  if tg_table_name = 'assets' then
    select p.workspace_id into target_workspace_id
    from public.projects p
    where p.id = new.project_id;

    if target_workspace_id is not null and new.workspace_id is distinct from target_workspace_id then
      raise exception 'asset workspace % does not match project % workspace %',
        new.workspace_id, new.project_id, target_workspace_id
        using errcode = 'check_violation';
    end if;
  else
    target_workspace_id := new.workspace_id;
  end if;

  if public.owner_tier(target_workspace_id) = 'free'::public.user_tier
     and new.visibility = 'private'::public.visibility then
    raise exception 'free tier cannot make content private (workspace %)', target_workspace_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists projects_visibility_tier on public.projects;
create trigger projects_visibility_tier
  before insert or update of visibility, workspace_id on public.projects
  for each row execute function public.enforce_visibility_tier();

drop trigger if exists assets_visibility_tier on public.assets;
create trigger assets_visibility_tier
  before insert or update of visibility, workspace_id on public.assets
  for each row execute function public.enforce_visibility_tier();
