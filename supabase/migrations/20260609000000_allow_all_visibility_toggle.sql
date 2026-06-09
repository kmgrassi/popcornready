-- Make public/private content visibility available to ALL users for now.
--
-- The data model ships a tier→visibility guard (free tier cannot make content
-- private) enforced by BEFORE triggers. Until billing tiers exist, every user is
-- 'free', so that guard blocks the visibility toggle entirely. Drop the two
-- triggers so any user can flip an asset/project public<->private. Keep the
-- enforce_visibility_tier() function in place so re-enabling the guard when
-- billing lands is just re-attaching the triggers.

drop trigger if exists assets_visibility_tier on public.assets;
drop trigger if exists projects_visibility_tier on public.projects;

comment on function public.enforce_visibility_tier() is
  'Tier->visibility guard (free tier cannot set content private). The '
  'assets_visibility_tier / projects_visibility_tier triggers were dropped in '
  'migration 20260609000000 to make public/private available to all users; '
  're-attach them when billing tiers ship.';
