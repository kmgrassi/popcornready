-- Make public/private content visibility available to ALL users for now.
--
-- The data model ships a tier->visibility guard (free tier cannot make content
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
  'migration 20260609020000 to make public/private available to all users; '
  're-attach them when billing tiers ship.';

-- enforce_visibility_tier() did double duty on the assets trigger: besides tier
-- gating it also guaranteed an asset's workspace_id matches the workspace of its
-- project_id. Dropping the trigger would lose that integrity check, letting a
-- service-role write persist a cross-workspace asset row (which the new workspace
-- asset list could then surface with another workspace's project metadata).
-- Preserve the consistency check with a dedicated, tier-agnostic trigger.
create or replace function public.enforce_asset_workspace_consistency()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_workspace_id uuid;
begin
  select p.workspace_id into target_workspace_id
  from public.projects p
  where p.id = new.project_id;

  if target_workspace_id is null then
    raise exception 'asset project does not exist (%)', new.project_id
      using errcode = 'foreign_key_violation';
  end if;

  if new.workspace_id is distinct from target_workspace_id then
    raise exception 'asset workspace % does not match project % workspace %',
      new.workspace_id, new.project_id, target_workspace_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists assets_workspace_consistency on public.assets;
create trigger assets_workspace_consistency
  before insert or update of workspace_id, project_id on public.assets
  for each row execute function public.enforce_asset_workspace_consistency();
