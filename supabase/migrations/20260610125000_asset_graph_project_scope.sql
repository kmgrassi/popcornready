-- Project-scope integrity for the asset graph (catch-up for PR #260 review).
--
-- 20260610120000 shipped asset_edges and selections with single-column FKs to
-- assets(id): nothing stopped an edge or a selection in project A from
-- referencing project B's asset, so a public project could surface or traverse
-- a foreign (possibly private) asset id. The assets_sync_edges trigger guards
-- only the assets->edges path; direct inserts bypassed it.
--
-- Fix: make same-project membership declarative. assets gains a
-- (project_id, id) uniqueness target, and the referencing tables swap to
-- composite FKs so the invariant holds on every write path, trigger or not.
-- (Additive on applied history — we never rewrite applied migrations.)

-- Composite FK target. assets.project_id is immutable (assets_guard_immutable),
-- so referencing rows can never be orphaned by a project move.
alter table public.assets
  add constraint assets_project_id_id_unique unique (project_id, id);

-- asset_edges: both endpoints must live in THIS project. The sync trigger's
-- check stays — it fires first with a clearer error message.
alter table public.asset_edges
  drop constraint asset_edges_from_id_fkey,
  drop constraint asset_edges_to_id_fkey,
  add constraint asset_edges_from_fk foreign key (project_id, from_id)
    references public.assets (project_id, id) on delete cascade,
  add constraint asset_edges_to_fk foreign key (project_id, to_id)
    references public.assets (project_id, id) on delete cascade;

-- selections: a slot can only activate an asset from its own project — a
-- selection in project A can never surface project B's asset.
alter table public.selections
  drop constraint selections_active_asset_id_fkey,
  add constraint selections_active_asset_fk foreign key (project_id, active_asset_id)
    references public.assets (project_id, id) on delete cascade;
