-- Server-side Studio wizard drafts.
--
-- Drafts are workspace-scoped and owned by the app/domain user
-- (public.users.id), never auth.uid(). The nullable local_actor_id supports
-- AUTH_MODE=local, where the API writes through the service-role client and no
-- persisted domain user exists.

create table public.studio_drafts (
  id              uuid primary key default gen_random_uuid(),
  schema_version  text        not null default 'studioDraft.v1',
  workspace_id    uuid        not null references public.workspaces (id) on delete cascade,
  owner_user_id   uuid        references public.users (id) on delete cascade,
  local_actor_id  text,
  payload         jsonb       not null,
  display_excerpt text        not null,
  step            text        not null check (step in ('brief', 'footage', 'story', 'generate', 'review', 'export')),
  project_id      uuid        references public.projects (id) on delete set null,
  run_id          uuid        references public.generation_runs (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint studio_drafts_owner_check check (
    (owner_user_id is not null and local_actor_id is null)
    or (owner_user_id is null and local_actor_id is not null)
  ),
  constraint studio_drafts_payload_version_check check ((payload ->> 'v') = '1')
);

create index studio_drafts_owner_newest_idx
  on public.studio_drafts (workspace_id, owner_user_id, updated_at desc, id desc)
  where owner_user_id is not null;

create index studio_drafts_local_newest_idx
  on public.studio_drafts (workspace_id, local_actor_id, updated_at desc, id desc)
  where local_actor_id is not null;

create index studio_drafts_project_id_idx on public.studio_drafts (project_id);
create index studio_drafts_run_id_idx on public.studio_drafts (run_id);

create or replace function public.validate_studio_draft_refs()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project_workspace_id uuid;
  v_run_project_id uuid;
  v_run_workspace_id uuid;
begin
  if new.project_id is not null then
    select p.workspace_id into v_project_workspace_id
    from public.projects p
    where p.id = new.project_id;

    if v_project_workspace_id is null then
      raise exception 'studio draft project does not exist (%)', new.project_id
        using errcode = 'foreign_key_violation';
    end if;

    if v_project_workspace_id is distinct from new.workspace_id then
      raise exception 'studio draft project workspace % does not match draft workspace %',
        v_project_workspace_id, new.workspace_id
        using errcode = 'check_violation';
    end if;
  end if;

  if new.run_id is not null then
    select r.project_id, p.workspace_id
      into v_run_project_id, v_run_workspace_id
    from public.generation_runs r
    join public.projects p on p.id = r.project_id
    where r.id = new.run_id;

    if v_run_project_id is null then
      raise exception 'studio draft run does not exist (%)', new.run_id
        using errcode = 'foreign_key_violation';
    end if;

    if v_run_workspace_id is distinct from new.workspace_id then
      raise exception 'studio draft run workspace % does not match draft workspace %',
        v_run_workspace_id, new.workspace_id
        using errcode = 'check_violation';
    end if;

    if new.project_id is not null and new.project_id is distinct from v_run_project_id then
      raise exception 'studio draft project % does not match run project %',
        new.project_id, v_run_project_id
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.validate_studio_draft_refs() from public;

create trigger studio_drafts_set_updated_at
  before update on public.studio_drafts
  for each row execute function public.set_updated_at();

create trigger studio_drafts_validate_refs
  before insert or update of workspace_id, project_id, run_id on public.studio_drafts
  for each row execute function public.validate_studio_draft_refs();

alter table public.studio_drafts enable row level security;

create policy studio_drafts_select on public.studio_drafts
  for select to authenticated
  using (
    public.is_workspace_member(workspace_id)
    and owner_user_id = public.current_app_user_id()
  );

create policy studio_drafts_insert on public.studio_drafts
  for insert to authenticated
  with check (
    public.is_workspace_member(workspace_id)
    and owner_user_id = public.current_app_user_id()
  );

create policy studio_drafts_update on public.studio_drafts
  for update to authenticated
  using (
    public.is_workspace_member(workspace_id)
    and owner_user_id = public.current_app_user_id()
  )
  with check (
    public.is_workspace_member(workspace_id)
    and owner_user_id = public.current_app_user_id()
  );

create policy studio_drafts_delete on public.studio_drafts
  for delete to authenticated
  using (
    public.is_workspace_member(workspace_id)
    and owner_user_id = public.current_app_user_id()
  );
