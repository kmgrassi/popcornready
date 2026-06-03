-- Workspace membership + unify workspace authz on the public.users domain id.
--
-- Builds on public.users (the domain user table) to give workspaces real
-- membership (owner / admin / member) instead of a single owner_id, and resolves
-- the identity inconsistency flagged in docs/supabase-identity-and-rls.md:
-- the #125 v1 schema keyed workspace ownership on auth.uid(), while everything
-- built on public.users keys on the domain id. This migration moves workspace
-- authz fully onto the domain id (public.users.id) via current_app_user_id().
--
-- Identity rules (see docs/supabase-identity-and-rls.md):
--   * auth.uid()              = auth session id
--   * public.users.id         = app/domain user id   <- workspace owner/members key on this
--   * current_app_user_id()   = the caller's public.users.id

-- --- membership table ------------------------------------------------------
create table public.workspace_members (
  workspace_id text not null references public.workspaces (id) on delete cascade,
  user_id      uuid not null references public.users (id) on delete cascade,
  role         text not null default 'member' check (role in ('owner', 'admin', 'member')),
  invited_by   uuid references public.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index idx_workspace_members_user_id on public.workspace_members (user_id);

-- public.set_updated_at() already exists (public.users migration).
create trigger workspace_members_set_updated_at
  before update on public.workspace_members
  for each row execute function public.set_updated_at();

-- --- repoint workspaces.owner_id: auth.users -> public.users ----------------
-- #125 declared owner_id uuid references auth.users(id). Make it the domain id
-- so it matches workspace_members.user_id and current_app_user_id().
alter table public.workspaces drop constraint workspaces_owner_id_fkey;

update public.workspaces w
set owner_id = u.id
from public.users u
where u.auth_id = w.owner_id;

-- Null out any owner_id that didn't map (orphaned auth ref) so the new FK holds.
update public.workspaces w
set owner_id = null
where owner_id is not null
  and not exists (select 1 from public.users u where u.id = w.owner_id);

alter table public.workspaces
  add constraint workspaces_owner_id_fkey
  foreign key (owner_id) references public.users (id) on delete set null;

-- Backfill an owner membership row for every existing workspace.
insert into public.workspace_members (workspace_id, user_id, role)
select w.id, w.owner_id, 'owner'
from public.workspaces w
where w.owner_id is not null
on conflict (workspace_id, user_id) do nothing;

-- --- membership helpers (SECURITY DEFINER to avoid RLS recursion) -----------
create or replace function public.is_workspace_member(p_workspace_id text)
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
revoke all on function public.is_workspace_member(text) from public;
grant execute on function public.is_workspace_member(text) to authenticated, service_role;

create or replace function public.is_workspace_admin(p_workspace_id text)
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
revoke all on function public.is_workspace_admin(text) from public;
grant execute on function public.is_workspace_admin(text) to authenticated, service_role;

-- --- reroute the #125 ownership helpers onto membership + domain identity ---
-- Every v1 policy (projects/assets/jobs/brief_versions/compositions/timelines/
-- generation_*) calls owns_workspace()/owns_project(), so replacing the function
-- bodies migrates them all at once: access now follows workspace membership and
-- keys on public.users.id instead of auth.uid(). Param names are unchanged so
-- CREATE OR REPLACE is valid.
create or replace function public.owns_workspace(ws_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_workspace_member(ws_id);
$$;

create or replace function public.owns_project(proj_id text)
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

-- --- workspaces RLS: replace the auth.uid()-based owner policy ---------------
-- #125's workspaces_owner compared owner_id = auth.uid(); owner_id is now a
-- domain id, so that comparison is wrong. Split into member-read / admin-write.
drop policy if exists workspaces_owner on public.workspaces;

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

-- --- workspace_members RLS -------------------------------------------------
-- Members can see co-members; only owners/admins manage membership (= invites).
-- Bootstrapping the first owner row happens server-side via service_role (which
-- bypasses RLS), e.g. when a workspace is created.
alter table public.workspace_members enable row level security;

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
