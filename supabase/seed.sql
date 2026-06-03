-- Seed data for local/dev. Applied by `supabase db reset` (local) and can be run
-- against remote manually. Ported from .local/agent-store.json so the existing
-- dev workspace + smoke-test projects exist after migrating to Postgres.
--
-- owner_id is left null here: the local dev workspace predates Supabase auth.
-- With RLS on, null-owner rows are invisible to end users and reachable only via
-- the service_role key. To attach this workspace to a real account, set
-- owner_id to that user's auth.users.id.

insert into workspaces (id, schema_version, name, created_at, updated_at) values
  ('ws_local_dev', 'workspace.v1', 'dev_workspace',
   '2026-06-02T15:20:06.143Z', '2026-06-02T15:20:06.143Z')
on conflict (id) do nothing;

insert into projects (id, schema_version, workspace_id, name, status, brief, current_brief_version_id, created_at, updated_at) values
  ('proj_rd816e29', 'project.v1', 'ws_local_dev', 'NVIDIA Cosmos smoke test', 'active', null, null,
   '2026-06-02T15:20:15.340Z', '2026-06-02T15:20:15.340Z'),
  ('proj_e9nmi5lm', 'project.v1', 'ws_local_dev', 'NVIDIA Cosmos smoke test', 'active', null, null,
   '2026-06-02T15:24:34.857Z', '2026-06-02T15:24:34.857Z'),
  ('proj_p4kuybe4', 'project.v1', 'ws_local_dev', 'NVIDIA Cosmos smoke test', 'active', null, null,
   '2026-06-02T15:30:14.727Z', '2026-06-02T15:30:14.727Z')
on conflict (id) do nothing;
