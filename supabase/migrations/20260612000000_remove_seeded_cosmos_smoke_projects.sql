-- Remove the obsolete local/dev NVIDIA Cosmos smoke-test projects that were
-- previously inserted by supabase/seed.sql. Child rows are removed through the
-- existing project-scoped ON DELETE CASCADE foreign keys.
delete from public.projects p
using public.workspaces w
where p.workspace_id = w.id
  and w.owner_id is null
  and lower(w.name) = 'dev_workspace'
  and p.name = 'NVIDIA Cosmos smoke test'
  and p.created_at in (
    timestamptz '2026-06-02T15:20:15.340Z',
    timestamptz '2026-06-02T15:24:34.857Z',
    timestamptz '2026-06-02T15:30:14.727Z'
  );
