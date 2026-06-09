-- History-alignment stub. Version 20260609000000 is already recorded in the
-- remote supabase_migrations.schema_migrations (it was applied as
-- "run_review_feedback" before the version collision was untangled). Supabase's
-- `db push` compares the local supabase/migrations folder against that remote
-- history and errors on drift if a recorded remote version has no local file —
-- so this file must exist to keep CI's `supabase db push` happy. It is already
-- applied remotely and will be skipped (never re-run); the statement is the
-- idempotent original anyway.
--
-- The "live" run_review_feedback migration is 20260609010000 and the visibility
-- toggle moved to 20260609020000. See migration 20260609020000 and PR #236 for
-- the full collision write-up.
alter table public.generation_runs
  add column if not exists review_feedback text;
