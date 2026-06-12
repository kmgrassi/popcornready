-- Seed data for local/dev. Applied by `supabase db reset` (local) and can be run
-- against remote manually. Recreates the dev workspace.
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
