-- Private `assets` bucket for uploaded + generated media bytes.
--
-- Private (public = false): the server reads/writes via the service_role key
-- (which bypasses Storage RLS), and the browser receives short-lived signed URLs
-- minted server-side. No anon/public object access, so no per-object RLS policy
-- is needed for the current model.

insert into storage.buckets (id, name, public)
values ('assets', 'assets', false)
on conflict (id) do nothing;
