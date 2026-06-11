-- Add 'poster' to graph_asset_kind: the project's marketing one-sheet image,
-- shown as the project thumbnail in the dashboard grid. The current poster is
-- a project-scoped selection slot (slot_owner_lineage_id null, slot_role
-- 'poster') — no new tables.
--
-- A new enum value cannot be referenced in the transaction that adds it, so
-- the assets_kind_media constraint and assets_set_ref updates live in the
-- next migration file (each migration runs in its own transaction).

alter type graph_asset_kind add value if not exists 'poster';
