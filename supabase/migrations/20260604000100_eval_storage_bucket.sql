-- Private content-addressed bucket for eval fixture media.
--
-- Eval cases store text artifacts inline in their row JSON. Media artifacts are
-- copied into this bucket by sha256-derived object keys so fixtures do not point
-- at mutable project asset storage. Objects are intentionally immutable from the
-- app's point of view: duplicate captures reuse the existing object, and no app
-- code should delete from this bucket.
--
-- Private (public = false): server-side eval tooling reads/writes with the
-- service_role key. No anon/public object access.

insert into storage.buckets (id, name, public)
values ('eval', 'eval', false)
on conflict (id) do nothing;
