-- Seed data for local/dev. Applied by `supabase db reset` (local) and can be run
-- against remote manually. Recreates the dev workspace + smoke-test projects.
--
-- IDs are DB-generated uuids now (the app no longer mints text ids), so the seed
-- inserts by natural key and lets gen_random_uuid() fill the primary keys. The
-- dev workspace has a null owner_id: with RLS on, null-owner rows are reachable
-- only via the service_role key. To attach it to a real account, set owner_id to
-- that user's public.users.id.

-- One unowned local dev workspace (matched by lower(name); see workspaces_unique_local_name).
insert into public.workspaces (schema_version, name, created_at, updated_at)
select 'workspace.v1', 'dev_workspace',
       '2026-06-02T15:20:06.143Z', '2026-06-02T15:20:06.143Z'
where not exists (
  select 1 from public.workspaces
  where owner_id is null and lower(name) = 'dev_workspace'
);

-- Smoke-test projects under the dev workspace.
insert into public.projects (schema_version, workspace_id, name, status, created_at, updated_at)
select 'project.v1', w.id, v.name, 'active', v.created_at, v.created_at
from (
  select id from public.workspaces
  where owner_id is null and lower(name) = 'dev_workspace'
  limit 1
) w
cross join (values
  ('NVIDIA Cosmos smoke test', timestamptz '2026-06-02T15:20:15.340Z'),
  ('NVIDIA Cosmos smoke test', timestamptz '2026-06-02T15:24:34.857Z'),
  ('NVIDIA Cosmos smoke test', timestamptz '2026-06-02T15:30:14.727Z')
) as v(name, created_at)
where not exists (
  select 1
  from public.projects p
  join public.workspaces ww on ww.id = p.workspace_id
  where ww.owner_id is null and lower(ww.name) = 'dev_workspace'
);
