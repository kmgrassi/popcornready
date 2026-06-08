-- Storyboard & Scenes (PR6 — Storyboard editing): persist the editable plan.
--
-- The storyboard view edits a project's EditPlan (Scenes → Beats). It needs a
-- stable home so edits survive across sessions and so single-beat tile
-- regeneration can recompute only the affected beat. We store the whole
-- EditPlan as jsonb on the project (loosely-shaped, still-churning structure —
-- consistent with how briefs/segments/provenance are stored per the v1 model).
--
-- Scene/Beat ids inside the jsonb stay stable across edits (minted client/server
-- side); the column carries the canonical persisted plan the UI reads back.

alter table public.projects
  add column plan jsonb;

comment on column public.projects.plan is
  'The project''s editable storyboard EditPlan (Scenes -> Beats) as jsonb. Edited by the storyboard view; ids are stable across edits. Null until a plan exists.';
