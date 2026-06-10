-- Popcorn Ready — squashed baseline: the asset-graph data model (North Star P1).
--
-- This single migration REPLACES the previous migration set
-- (20260603000000_init_schema.sql + the 20260608/20260609 follow-ups), the same
-- squash maneuver init_schema itself performed. The database holds no data
-- worth porting (verified before landing — see the guard step in
-- docs/scopes/asset-graph-schema.md §5), so the retired creative-state tables
-- (compositions, edit_graphs, timelines, brief_versions, generation_stages,
-- generation_stage_items, generation_stage_artifacts) and their enums simply
-- do not exist here — nothing to drop, nothing to confuse future work.
--
-- The model (full rationale: docs/scopes/asset-graph-schema.md, docs/NORTH_STAR.md):
--   * assets       — ONE immutable, project-scoped pool for every artifact kind
--                    (source footage, brief, beats, anchors, keyframes, clips,
--                    audio, critiques, plan, composites/the cut, renders).
--                    Editing inserts a new version sharing lineage_id.
--   * asset_edges  — the dependency/provenance graph, trigger-synced from each
--                    asset's write-once `inputs` snapshot; acyclic by
--                    construction; strictly intra-project.
--   * selections   — append-only active pointers per slot; per-slot seq is the
--                    compare-and-set token for parallel agents.
--   * actions      — the agent decision log (tool, inputs, rationale,
--                    proposal/approval, cost).
--   * generation_runs — slimmed to a session/budget grouping over actions.
--   * jobs         — unchanged async execution substrate (composition/revision
--                    job types retired).
--
-- Identity & RLS conventions: docs/supabase-identity-and-rls.md + supabase/README.md.
-- Because this rewrites the migration history, the linked dev database must be
-- reset (`supabase db reset --linked`) so it re-applies from this baseline.
-- The reset wipes auth.users — dev logins must re-sign-up.

set check_function_bodies = off;

create extension if not exists pgcrypto;

-- ===========================================================================
-- 0. Enums
-- ===========================================================================
create type project_status as enum ('active', 'deleted');
create type asset_status   as enum ('pending', 'processing', 'ready', 'failed');

-- What an asset IS, semantically (the agent routes on this).
create type graph_asset_kind as enum (
  'source_footage',    -- uploaded/ingested media
  'brief',             -- creative brief (data)
  'beat',              -- one story beat (data)
  'anchor',            -- reference image w/ identity invariants (characters fold in here)
  'keyframe',          -- per-beat keyframe image
  'clip',              -- generated video clip
  'audio_track',       -- music / narration audio
  'narration_script',  -- narration text (data)
  'critique',          -- critic report over another asset (data)
  'plan',              -- ordered composite of beats (data)
  'composite',         -- ordered video stitch: scene / sub-video / the cut (data)
  'render'             -- exported encode of a composite
);

-- Physical representation: 'data' lives in assets.content (jsonb);
-- image/video/audio live in Storage via storage_key.
create type asset_media as enum ('data', 'image', 'video', 'audio');

-- Edge semantics, consumer -> consumed:
--   input  : semantic input the asset was generated from
--   anchor : identity/consistency reference (a kind of input, queried separately)
--   child  : ordered member of a composite (position required)
create type edge_relation as enum ('input', 'anchor', 'child');

create type action_status as enum
  ('proposed', 'approved', 'rejected', 'running', 'applied', 'failed');

-- 'composition'/'revision' job types are retired with the old engine.
create type job_type   as enum ('asset_ingest', 'asset_generation', 'generation', 'export', 'audio_alignment');
create type job_status as enum ('queued', 'running', 'succeeded', 'failed', 'canceled');

-- eval framework.
create type eval_run_source      as enum ('suite', 'manual_workbench');
create type eval_generation_mode as enum ('prompts_only', 'full');
create type eval_run_status      as enum ('queued', 'running', 'succeeded', 'failed');
create type judgment_verdict     as enum ('pass', 'needs_review', 'fail');
create type judgment_trigger     as enum ('auto', 'manual');

-- tiers / content visibility.
create type public.user_tier  as enum ('free', 'paid');
create type public.visibility as enum ('public', 'private');

-- ===========================================================================
-- 1. Domain users (decoupled from auth.users) + shared helpers.
-- ===========================================================================
-- public.users.id is the app/domain user id; auth_id links to auth.users and is
-- NULL until signup (lets us pre-create invited users). RLS resolves
-- auth.uid() -> public.users.id via current_app_user_id().
create table public.users (
  id              uuid primary key default gen_random_uuid(),
  auth_id         uuid unique references auth.users (id) on delete set null,
  email           text,
  full_name       text,
  first_name      text,
  last_name       text,
  avatar_url      text,
  metadata        jsonb         not null default '{}'::jsonb,
  -- Tier metadata (changed only by trusted server roles; see guard trigger).
  tier            public.user_tier not null default 'free',
  tier_source     text,
  tier_changed_at timestamptz   not null default now(),
  created_at      timestamptz   not null default now(),
  updated_at      timestamptz   not null default now()
);

-- One unlinked (pre-auth) row per email so the signup trigger can link unambiguously.
create unique index users_unique_unlinked_email
  on public.users (lower(btrim(email)))
  where auth_id is null and email is not null and btrim(email) <> '';

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger users_set_updated_at
  before update on public.users
  for each row execute function public.set_updated_at();

-- auth.uid() -> public.users.id. SECURITY DEFINER so RLS policies on other tables
-- can call it without recursing through public.users' own RLS.
create or replace function public.current_app_user_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.users where auth_id = auth.uid() limit 1
$$;
revoke all on function public.current_app_user_id() from public;
grant execute on function public.current_app_user_id() to authenticated, service_role;

-- auth.users -> public.users mirror / link on signup.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_first_name text := new.raw_user_meta_data ->> 'first_name';
  v_last_name  text := new.raw_user_meta_data ->> 'last_name';
  v_full_name  text := nullif(btrim(concat_ws(' ', v_first_name, v_last_name)), '');
  v_email      text := coalesce(new.email, new.raw_user_meta_data ->> 'email');
  v_existing   uuid;
begin
  if nullif(v_email, '') is not null then
    select id into v_existing
    from public.users
    where auth_id is null
      and lower(btrim(email)) = lower(btrim(v_email));
  end if;

  if v_existing is not null then
    update public.users set
      auth_id    = new.id,
      first_name = coalesce(first_name, nullif(v_first_name, '')),
      last_name  = coalesce(last_name,  nullif(v_last_name, '')),
      full_name  = coalesce(full_name,  v_full_name),
      avatar_url = coalesce(avatar_url, new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture'),
      metadata   = metadata || coalesce(new.raw_user_meta_data, '{}'::jsonb)
    where id = v_existing;
  else
    insert into public.users (auth_id, email, full_name, first_name, last_name, avatar_url, metadata)
    values (
      new.id,
      v_email,
      coalesce(v_full_name, new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
      v_first_name,
      v_last_name,
      coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture'),
      coalesce(new.raw_user_meta_data, '{}'::jsonb)
    );
  end if;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Tier fields are server-owned: block changes from anon/authenticated, and bump
-- tier_changed_at whenever the tier actually changes.
create or replace function public.guard_user_tier_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (
    new.tier is distinct from old.tier
    or new.tier_source is distinct from old.tier_source
    or new.tier_changed_at is distinct from old.tier_changed_at
  ) and coalesce(auth.role(), '') <> 'service_role'
    and current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'user tier fields can only be changed by trusted server roles'
      using errcode = 'insufficient_privilege';
  end if;

  if new.tier is distinct from old.tier then
    new.tier_changed_at := now();
  end if;

  return new;
end;
$$;

create trigger users_guard_tier_update
  before update of tier, tier_source, tier_changed_at on public.users
  for each row execute function public.guard_user_tier_update();

-- RLS: a signed-in user reads/updates only their own linked row. Pre-auth (invite)
-- rows have auth_id NULL and are managed server-side via the service_role.
alter table public.users enable row level security;

create policy users_select_own on public.users
  for select to authenticated
  using (auth_id = auth.uid());

create policy users_update_own on public.users
  for update to authenticated
  using (auth_id = auth.uid())
  with check (auth_id = auth.uid());

-- owner_tier: the tier of the user owning a workspace ('free' when unowned/missing).
create or replace function public.owner_tier(ws_id uuid)
returns public.user_tier
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(u.tier, 'free'::public.user_tier)
  from public.workspaces w
  left join public.users u on u.id = w.owner_id
  where w.id = ws_id
$$;
revoke all on function public.owner_tier(uuid) from public;
grant execute on function public.owner_tier(uuid) to anon, authenticated, service_role;

-- ===========================================================================
-- 2. Storage buckets (private; server reads/writes via service_role).
-- ===========================================================================
insert into storage.buckets (id, name, public)
values ('assets', 'assets', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('eval', 'eval', false)
on conflict (id) do nothing;

-- ===========================================================================
-- 3. Workspaces + membership + invites.
-- ===========================================================================
create table public.workspaces (
  id             uuid primary key default gen_random_uuid(),
  schema_version text        not null default 'workspace.v1',
  -- Domain user (public.users.id) that owns this workspace; null for the seeded
  -- local dev workspace.
  owner_id       uuid        references public.users (id) on delete set null,
  name           text        not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Natural-key uniqueness backing find-or-create (app no longer mints ids):
--   * One workspace per owning domain user.
--   * One unowned local dev workspace per name.
create unique index workspaces_unique_owner
  on public.workspaces (owner_id)
  where owner_id is not null;
create unique index workspaces_unique_local_name
  on public.workspaces (lower(name))
  where owner_id is null;

create trigger workspaces_set_updated_at
  before update on public.workspaces
  for each row execute function public.set_updated_at();

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id      uuid not null references public.users (id) on delete cascade,
  role         text not null default 'member' check (role in ('owner', 'admin', 'member')),
  invited_by   uuid references public.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index idx_workspace_members_user_id on public.workspace_members (user_id);

create trigger workspace_members_set_updated_at
  before update on public.workspace_members
  for each row execute function public.set_updated_at();

create table public.workspace_invites (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  email         text not null check (btrim(email) <> ''),
  role          text not null default 'member' check (role in ('owner', 'admin', 'member')),
  invited_by    uuid references public.users (id) on delete set null,
  -- 64-char hex token from two core gen_random_uuid()s (~244 bits of entropy).
  -- Avoids pgcrypto's gen_random_bytes, which on Supabase lives in the
  -- `extensions` schema and is not on the search_path at migration time.
  token         text not null unique
                  default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  status        text not null default 'pending'
                  check (status in ('pending', 'accepted', 'revoked', 'expired')),
  expires_at    timestamptz not null default (now() + interval '14 days'),
  accepted_by   uuid references public.users (id) on delete set null,
  accepted_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index idx_workspace_invites_workspace_id on public.workspace_invites (workspace_id);
create index idx_workspace_invites_email_lower on public.workspace_invites (lower(btrim(email)));
create unique index workspace_invites_unique_pending
  on public.workspace_invites (workspace_id, lower(btrim(email)))
  where status = 'pending';

create trigger workspace_invites_set_updated_at
  before update on public.workspace_invites
  for each row execute function public.set_updated_at();

-- --- membership / ownership helpers ----------------------------------------
create or replace function public.handle_new_workspace()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.owner_id is not null then
    insert into public.workspace_members (workspace_id, user_id, role)
    values (new.id, new.owner_id, 'owner')
    on conflict (workspace_id, user_id) do nothing;
  end if;
  return new;
end;
$$;

create trigger on_workspace_created
  after insert on public.workspaces
  for each row execute function public.handle_new_workspace();

create or replace function public.is_workspace_member(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = p_workspace_id
      and wm.user_id = public.current_app_user_id()
  );
$$;
revoke all on function public.is_workspace_member(uuid) from public;
grant execute on function public.is_workspace_member(uuid) to authenticated, service_role;

create or replace function public.is_workspace_admin(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = p_workspace_id
      and wm.user_id = public.current_app_user_id()
      and wm.role in ('owner', 'admin')
  );
$$;
revoke all on function public.is_workspace_admin(uuid) from public;
grant execute on function public.is_workspace_admin(uuid) to authenticated, service_role;

create or replace function public.owns_workspace(ws_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_workspace_member(ws_id);
$$;

create or replace function public.owns_project(proj_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.projects p
    join public.workspace_members wm on wm.workspace_id = p.workspace_id
    where p.id = proj_id
      and wm.user_id = public.current_app_user_id()
  );
$$;

-- --- invite accept/expire flows --------------------------------------------
create or replace function public.accept_workspace_invite(p_token text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id      uuid := public.current_app_user_id();
  v_invite       public.workspace_invites%rowtype;
  v_caller_email text;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select * into v_invite
  from public.workspace_invites
  where token = p_token
  for update;

  if not found then
    raise exception 'invite not found' using errcode = 'P0002';
  end if;

  if v_invite.status = 'accepted' and v_invite.accepted_by = v_user_id then
    return v_invite.workspace_id;
  end if;

  if v_invite.status <> 'pending' then
    raise exception 'invite is % (not pending)', v_invite.status using errcode = '22023';
  end if;

  if v_invite.expires_at <= now() then
    raise exception 'invite has expired' using errcode = '22023';
  end if;

  select email into v_caller_email from public.users where id = v_user_id;
  if v_caller_email is null
     or lower(btrim(v_caller_email)) is distinct from lower(btrim(v_invite.email)) then
    raise exception 'invite is addressed to a different email'
      using errcode = '42501';
  end if;

  insert into public.workspace_members (workspace_id, user_id, role, invited_by)
  values (v_invite.workspace_id, v_user_id, v_invite.role, v_invite.invited_by)
  on conflict (workspace_id, user_id) do nothing;

  update public.workspace_invites
    set status      = 'accepted',
        accepted_by = v_user_id,
        accepted_at = now()
    where id = v_invite.id;

  return v_invite.workspace_id;
end;
$$;
revoke all on function public.accept_workspace_invite(text) from public;
grant execute on function public.accept_workspace_invite(text) to authenticated, service_role;

create or replace function public.expire_stale_workspace_invites()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update public.workspace_invites
    set status = 'expired'
    where status = 'pending'
      and expires_at <= now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.expire_stale_workspace_invites() from public;
grant execute on function public.expire_stale_workspace_invites() to service_role;

-- ===========================================================================
-- 4. Projects (the only creative-state container besides the pool).
-- ===========================================================================
-- No brief/plan jsonb and no brief_versions table: the brief, the plan, and
-- every beat are immutable rows in the assets pool; "current" is a selection.
create table public.projects (
  id             uuid primary key default gen_random_uuid(),
  schema_version text              not null default 'project.v1',
  workspace_id   uuid              not null references public.workspaces (id) on delete cascade,
  name           text              not null,
  status         project_status    not null default 'active',
  visibility     public.visibility not null default 'public',
  created_at     timestamptz       not null default now(),
  updated_at     timestamptz       not null default now()
);
create index projects_workspace_id_idx on public.projects (workspace_id);

comment on column public.projects.visibility is
  'Public/private discovery visibility. The tier guard trigger is detached until billing ships (see enforce_visibility_tier).';

-- ===========================================================================
-- 5. Generation runs — a session/budget grouping over actions.
-- ===========================================================================
-- No stage tables and no stage enum: progress is a UI projection over
-- actions + jobs. Gates are opt-in pause points by tool name (stops are
-- opt-in, North Star Principle 2); review feedback flows through actions.
create table public.generation_runs (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid             not null references public.projects (id) on delete cascade,
  status           job_status       not null default 'queued',
  budget_usd       double precision,
  gates            jsonb            not null default '[]'::jsonb,
  progress_percent double precision,
  message          text,
  error            jsonb,
  created_at       timestamptz      not null default now(),
  updated_at       timestamptz      not null default now(),
  started_at       timestamptz,
  completed_at     timestamptz
);
create index generation_runs_project_id_idx on public.generation_runs (project_id);

-- ===========================================================================
-- 6. Actions — the agent decision log.
-- ===========================================================================
create table public.actions (
  id                 uuid primary key default gen_random_uuid(),
  schema_version     text          not null default 'action.v1',
  project_id         uuid          not null references public.projects (id) on delete cascade,
  run_id             uuid          references public.generation_runs (id) on delete set null,
  -- The tool called: plan|replan|change_beat|generate_anchor|generate_keyframe|
  -- generate_clip|generate_audio|assemble|critique|swap_selection|export|...
  -- TEXT, not an enum: the tool surface evolves with the orchestrator.
  tool               text          not null,
  status             action_status not null default 'proposed',
  params             jsonb         not null default '{}'::jsonb,
  input_asset_ids    uuid[]        not null default '{}',
  rationale          text,
  -- Proposal = the agent's re-run plan before spending (Principle 5):
  -- { summary, plannedWork:[{tool, targetLineageId,...}],
  --   pinnedFingerprints: {assetId: inputs_fingerprint}, estimate:{...} }
  -- pinnedFingerprints is the optimistic-concurrency token: apply fails if a
  -- pinned slot moved underneath the proposal.
  proposal           jsonb,
  estimated_cost_usd double precision,
  actual_cost_usd    double precision,
  job_ids            uuid[]        not null default '{}',
  output_asset_ids   uuid[]        not null default '{}',
  error              jsonb,
  created_at         timestamptz   not null default now(),
  updated_at         timestamptz   not null default now()
);
create index actions_project_id_idx on public.actions (project_id, created_at desc);
create index actions_run_id_idx     on public.actions (run_id);

create trigger actions_set_updated_at
  before update on public.actions
  for each row execute function public.set_updated_at();

-- Decisions are auditable: once recorded, the WHAT may not be rewritten.
-- Lifecycle fields (status, costs, jobs, outputs, error) stay mutable.
create or replace function public.actions_guard_immutable()
returns trigger
language plpgsql
as $$
begin
  if new.project_id      is distinct from old.project_id
     or new.run_id       is distinct from old.run_id
     or new.tool         is distinct from old.tool
     or new.params       is distinct from old.params
     or new.input_asset_ids is distinct from old.input_asset_ids
     or new.rationale    is distinct from old.rationale
     or new.proposal     is distinct from old.proposal
  then
    raise exception 'action decision fields are immutable'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger actions_guard_immutable
  before update on public.actions
  for each row execute function public.actions_guard_immutable();

-- ===========================================================================
-- 7. Assets — the one immutable, project-scoped pool.
-- ===========================================================================
create table public.assets (
  id                   uuid              primary key default gen_random_uuid(),
  schema_version       text              not null default 'asset.v2',
  workspace_id         uuid              not null references public.workspaces (id) on delete cascade,
  project_id           uuid              not null references public.projects (id) on delete cascade,
  -- agent-legible short id, set by trigger: beat_x7f2c1, clip_9k3d0a, ...
  ref                  text,
  lineage_id           uuid              not null default gen_random_uuid(),
  version              integer           not null default 1,
  kind                 graph_asset_kind  not null,
  media                asset_media       not null,
  status               asset_status      not null default 'pending',
  -- what it depicts / is for: 'hero', 'beat:opening', 'background-music', ...
  role                 text,
  -- the body of data kinds (brief text, beat fields, composite children, ...)
  content              jsonb,
  -- generation request: { provider, model, prompt, providerPrompt, seed, ... }
  params               jsonb,
  -- write-once snapshot of inputs, mirrored to asset_edges by trigger:
  -- [{ assetId, relation, role?, position?, contentHash }]
  inputs               jsonb             not null default '[]'::jsonb,
  -- hash of this asset's own semantic content (media: set when bytes land)
  content_hash         text,
  -- hash over sorted (inputs[].contentHash) + hash(params): the staleness signal
  inputs_fingerprint   text,
  created_by_action_id uuid              references public.actions (id) on delete set null,
  -- media delivery + analysis
  filename             text,
  url                  text,
  remote_url           text,
  storage_key          text,
  storage_bucket       text,
  source               jsonb,
  duration_sec         double precision,
  description          text,
  context              jsonb,
  semantic_analysis    jsonb,
  visibility           public.visibility not null default 'public',
  created_at           timestamptz       not null default now(),
  updated_at           timestamptz       not null default now()
);

create trigger assets_set_updated_at
  before update on public.assets
  for each row execute function public.set_updated_at();

create unique index assets_project_ref_idx     on public.assets (project_id, ref);
create unique index assets_lineage_version_idx on public.assets (lineage_id, version);
create index assets_lineage_idx                on public.assets (lineage_id);
create index assets_project_kind_idx           on public.assets (project_id, kind);
create index assets_workspace_id_idx           on public.assets (workspace_id);

comment on column public.assets.visibility is
  'Asset-level public/private visibility. Effective public access also requires the owning project to be public.';
comment on column public.assets.storage_bucket is
  'Physical object bucket for delivery (tracks effective visibility once the S3/CloudFront storage toggle is wired).';

-- Shape coherence: data kinds carry content; media kinds carry storage.
alter table public.assets add constraint assets_media_shape check (
  (media = 'data' and content is not null)
  or (media <> 'data')
);
alter table public.assets add constraint assets_kind_media check (
  (kind in ('brief','beat','narration_script','critique','plan','composite')
     and media = 'data')
  or (kind in ('anchor','keyframe') and media = 'image')
  or (kind = 'audio_track' and media = 'audio')
  or (kind = 'clip' and media = 'video')
  or (kind in ('source_footage','render') and media <> 'data')
);

-- Agent-legible refs: short prefixed ids (beat_x7f2c1). Agents reason over ids
-- in context; bare uuids are token-expensive and transcription-error-prone.
create or replace function public.assets_set_ref()
returns trigger
language plpgsql
as $$
begin
  if new.ref is null then
    new.ref :=
      case new.kind
        when 'source_footage'   then 'src'
        when 'brief'            then 'brief'
        when 'beat'             then 'beat'
        when 'anchor'           then 'anc'
        when 'keyframe'         then 'kf'
        when 'clip'             then 'clip'
        when 'audio_track'      then 'aud'
        when 'narration_script' then 'narr'
        when 'critique'         then 'crit'
        when 'plan'             then 'plan'
        when 'composite'        then 'cut'
        when 'render'           then 'rend'
      end || '_' || substr(md5(gen_random_uuid()::text), 1, 6);
  end if;
  return new;
end;
$$;

create trigger assets_set_ref
  before insert on public.assets
  for each row execute function public.assets_set_ref();

-- Immutability: semantic fields reject UPDATE. Mutable lifecycle fields:
-- status, url/remote_url/storage_key/storage_bucket, duration_sec, filename,
-- description, visibility, context, semantic_analysis (analysis arrives late),
-- and content_hash exactly once (null -> value, when media bytes land).
create or replace function public.assets_guard_immutable()
returns trigger
language plpgsql
as $$
begin
  if new.kind                    is distinct from old.kind
     or new.media                is distinct from old.media
     or new.ref                  is distinct from old.ref
     or new.lineage_id           is distinct from old.lineage_id
     or new.version              is distinct from old.version
     or new.role                 is distinct from old.role
     or new.content              is distinct from old.content
     or new.params               is distinct from old.params
     or new.inputs               is distinct from old.inputs
     or new.inputs_fingerprint   is distinct from old.inputs_fingerprint
     or new.project_id           is distinct from old.project_id
     or new.workspace_id         is distinct from old.workspace_id
     or new.source               is distinct from old.source
     or new.created_by_action_id is distinct from old.created_by_action_id
     or (old.content_hash is not null
         and new.content_hash is distinct from old.content_hash)
  then
    raise exception 'asset semantic fields are immutable — insert a new version'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger assets_guard_immutable
  before update on public.assets
  for each row execute function public.assets_guard_immutable();

-- Nothing is throwaway (North Star Principle 9): deletes are service_role-only
-- (GDPR/admin escape hatch).
create or replace function public.assets_guard_delete()
returns trigger
language plpgsql
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'pool assets are never deleted'
      using errcode = 'insufficient_privilege';
  end if;
  return old;
end;
$$;

create trigger assets_guard_delete
  before delete on public.assets
  for each row execute function public.assets_guard_delete();

-- An asset's workspace must match its project's workspace (tier-agnostic
-- integrity check, carried over from migration 20260609020000).
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

create trigger assets_workspace_consistency
  before insert or update of workspace_id, project_id on public.assets
  for each row execute function public.enforce_asset_workspace_consistency();

-- ===========================================================================
-- 8. Asset edges — the dependency/provenance graph.
-- ===========================================================================
-- Direction: from_id (consumer/derived) -> to_id (consumed/input). A composite
-- may reference the same child at two positions (a reused scene), hence the
-- surrogate PK. Cascade FKs (not restrict): the never-delete invariant lives in
-- assets_guard_delete; restrict would race the project->assets cascade.
create table public.asset_edges (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid          not null references public.projects (id) on delete cascade,
  from_id    uuid          not null references public.assets (id) on delete cascade,
  to_id      uuid          not null references public.assets (id) on delete cascade,
  relation   edge_relation not null,
  role       text,
  position   integer,
  created_at timestamptz   not null default now(),
  constraint asset_edges_child_position check
    (relation <> 'child' or position is not null),
  constraint asset_edges_no_self check (from_id <> to_id)
);
create index asset_edges_from_idx    on public.asset_edges (from_id);
create index asset_edges_to_idx      on public.asset_edges (to_id);
create index asset_edges_project_idx on public.asset_edges (project_id);
create unique index asset_edges_child_order_idx
  on public.asset_edges (from_id, position) where relation = 'child';

-- Edges are written once, by trigger, from the new asset's `inputs` snapshot —
-- they cannot drift. Because inputs can only name rows that already exist, the
-- graph is acyclic by construction.
create or replace function public.assets_sync_edges()
returns trigger
language plpgsql
as $$
declare
  e jsonb;
  v_input_project uuid;
begin
  for e in select * from jsonb_array_elements(coalesce(new.inputs, '[]'::jsonb))
  loop
    -- Edges are strictly intra-project: cross-project reuse is import-by-copy
    -- with the origin recorded in `source`, never a graph edge — so blast
    -- radius and RLS can never leak across projects.
    select project_id into v_input_project
    from public.assets
    where id = (e ->> 'assetId')::uuid;
    if v_input_project is distinct from new.project_id then
      raise exception 'asset input % is not in project %', e ->> 'assetId', new.project_id
        using errcode = 'check_violation';
    end if;

    insert into public.asset_edges (project_id, from_id, to_id, relation, role, position)
    values (
      new.project_id,
      new.id,
      (e ->> 'assetId')::uuid,
      (e ->> 'relation')::edge_relation,
      e ->> 'role',
      nullif(e ->> 'position', '')::integer
    );
  end loop;
  return new;
end;
$$;

create trigger assets_sync_edges
  after insert on public.assets
  for each row execute function public.assets_sync_edges();

-- ===========================================================================
-- 9. Selections — append-only active pointers per slot.
-- ===========================================================================
-- A slot is (slot_owner_lineage_id, slot_role): the active version of a
-- lineage ('active'), a beat's keyframe/clip, or a project-scoped slot
-- (owner null: 'plan', 'cut'). History IS the undo stack.
create table public.selections (
  id                    uuid primary key default gen_random_uuid(),
  project_id            uuid        not null references public.projects (id) on delete cascade,
  slot_owner_lineage_id uuid,                 -- null = project-scoped slot
  slot_role             text        not null,
  seq                   integer     not null,
  active_asset_id       uuid        not null references public.assets (id) on delete cascade,
  set_by_action_id      uuid        references public.actions (id) on delete set null,
  created_at            timestamptz not null default now()
);
create index selections_project_idx on public.selections (project_id);
create index selections_asset_idx   on public.selections (active_asset_id);
-- Serves the current_selections distinct-on scan (the CAS unique index below
-- can't — it indexes a coalesce() expression, not the plain column).
create index selections_current_idx
  on public.selections (project_id, slot_owner_lineage_id, slot_role, seq desc);

-- Per-slot monotone seq; the unique index is the CAS arbiter — two agents
-- racing the same slot: one insert wins, the other errors and re-reads.
-- Clients applying a proposal should send an explicit seq (last seen + 1).
create unique index selections_slot_seq_idx on public.selections (
  project_id,
  coalesce(slot_owner_lineage_id, '00000000-0000-0000-0000-000000000000'::uuid),
  slot_role,
  seq
);

create or replace function public.selections_set_seq()
returns trigger
language plpgsql
as $$
begin
  if new.seq is null then
    select coalesce(max(s.seq), 0) + 1 into new.seq
    from public.selections s
    where s.project_id = new.project_id
      and s.slot_owner_lineage_id is not distinct from new.slot_owner_lineage_id
      and s.slot_role = new.slot_role;
  end if;
  return new;
end;
$$;

create trigger selections_set_seq
  before insert on public.selections
  for each row execute function public.selections_set_seq();

-- Append-only: revoke from anon/authenticated too — Supabase grants those
-- roles directly, so revoking only `public` would not actually strip them.
revoke update, delete on table public.selections from public, anon, authenticated;

-- Current state of every slot.
create or replace view public.current_selections
with (security_invoker = on) as
select distinct on (project_id, slot_owner_lineage_id, slot_role) *
from public.selections
order by project_id, slot_owner_lineage_id, slot_role, seq desc;

-- ===========================================================================
-- 10. Jobs + idempotency (unchanged execution substrate).
-- ===========================================================================
create table public.jobs (
  id              uuid primary key default gen_random_uuid(),
  schema_version  text        not null default 'job.v1',
  workspace_id    uuid        not null references public.workspaces (id) on delete cascade,
  project_id      uuid        not null references public.projects (id) on delete cascade,
  request_id      text,
  type            job_type    not null,
  status          job_status  not null default 'queued',
  progress        jsonb       not null default '{}'::jsonb,
  input           jsonb,
  result          jsonb,
  error           jsonb,
  idempotency_key text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index jobs_project_id_idx   on public.jobs (project_id);
create index jobs_workspace_id_idx on public.jobs (workspace_id);

create table public.idempotency (
  scope         text        not null,
  key           text        not null default '',
  body_hash     text,
  request_hash  text,
  job_id        uuid,
  status        integer,
  response_body jsonb,
  created_at    timestamptz not null default now(),
  primary key (scope, key)
);

-- ===========================================================================
-- 11. Graph queries.
-- ===========================================================================
-- Candidate stale set: everything downstream of a changed asset. This is a
-- SIGNAL to the agent, not a command (North Star §8) — the agent prunes it.
create or replace function public.downstream_assets(p_asset_id uuid)
returns table (asset_id uuid, depth integer)
language sql
stable
as $$
  with recursive d (asset_id, depth) as (
    select e.from_id, 1
    from public.asset_edges e
    where e.to_id = p_asset_id
    union
    select e.from_id, d.depth + 1
    from public.asset_edges e
    join d on e.to_id = d.asset_id
    where d.depth < 64
  )
  select d.asset_id, min(d.depth)
  from d
  group by d.asset_id
$$;

-- The orchestrator's working context: the whole project graph, token-compact.
-- (SQL function without SECURITY DEFINER -> runs under the caller's RLS.)
create or replace function public.project_manifest(p_project_id uuid)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'assets', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'ref', a.ref, 'kind', a.kind, 'status', a.status, 'role', a.role,
        'lineage', a.lineage_id, 'v', a.version,
        'summary', coalesce(a.description, a.content ->> 'summary'),
        'fp', a.inputs_fingerprint,
        'inputs', (
          select coalesce(jsonb_agg(jsonb_build_object(
            'ref', ia.ref, 'rel', e.relation, 'role', e.role, 'pos', e.position
          ) order by e.relation, e.position), '[]'::jsonb)
          from public.asset_edges e
          join public.assets ia on ia.id = e.to_id
          where e.from_id = a.id
        )
      ) order by a.created_at), '[]'::jsonb)
      from public.assets a
      where a.project_id = p_project_id
    ),
    'selections', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'owner', s.slot_owner_lineage_id, 'slot', s.slot_role, 'seq', s.seq,
        'active', (select ref from public.assets where id = s.active_asset_id)
      )), '[]'::jsonb)
      from public.current_selections s
      where s.project_id = p_project_id
    )
  )
$$;

-- ===========================================================================
-- 12. Eval entities (global admin/tooling records; service-role only).
-- ===========================================================================
create table public.eval_suites (
  id          uuid primary key default gen_random_uuid(),
  name        text        not null,
  description text,
  created_at  timestamptz not null default now()
);

create table public.eval_cases (
  id            uuid primary key default gen_random_uuid(),
  suite_id      uuid        not null references public.eval_suites (id) on delete cascade,
  label         text        not null,
  stimulus      jsonb       not null,
  stages_to_run jsonb       not null default '[]'::jsonb,
  expectations  jsonb,
  -- artifact ids inside `artifacts` are in-JSON keys (exempt).
  artifacts     jsonb       not null default '[]'::jsonb,
  created_at    timestamptz not null default now()
);
create index eval_cases_suite_id_idx on public.eval_cases (suite_id);

create table public.eval_runs (
  id              uuid                 primary key default gen_random_uuid(),
  source          eval_run_source      not null default 'suite',
  suite_id        uuid                 references public.eval_suites (id) on delete set null,
  generation_mode eval_generation_mode not null default 'prompts_only',
  -- Loose text (was the retired generation_stage_type enum): names the tool /
  -- checkpoint after which an eval run stops.
  stop_after      text,
  git_sha         text                 not null,
  branch          text                 not null,
  judge_models    jsonb                not null default '{}'::jsonb,
  status          eval_run_status      not null default 'queued',
  aggregate       jsonb,
  created_at      timestamptz          not null default now(),
  completed_at    timestamptz
);
create index eval_runs_suite_id_idx   on public.eval_runs (suite_id);
create index eval_runs_created_at_idx on public.eval_runs (created_at desc);

-- Single reconciled judgments table: inline runs set generation_run_id; offline
-- suite runs set eval_run_id/case_id. Append-only (UPDATE/DELETE revoked below).
create table public.judgments (
  id                 uuid             primary key default gen_random_uuid(),
  evaluator_id       text             not null,
  rubric_version     text             not null,
  judge_model        text             not null,
  generation_run_id  uuid             references public.generation_runs (id) on delete cascade,
  eval_run_id        uuid             references public.eval_runs (id) on delete cascade,
  case_id            uuid             references public.eval_cases (id) on delete set null,
  -- graph-node pointers: loose ids that may reference pool assets, actions, or
  -- offline artifacts, so they stay TEXT and are NOT FKs.
  stage_id           text             not null,
  item_id            text,
  artifact_id        text,
  asset_id           text,
  grades             jsonb            not null default '{}'::jsonb,
  verdict            judgment_verdict not null,
  rationale          text             not null,
  recommended_action text,
  evidence_ref       text,
  trigger            judgment_trigger not null,
  cost_usd           double precision not null default 0,
  latency_ms         double precision not null default 0,
  created_at         timestamptz      not null default now()
);
create index judgments_generation_run_id_idx on public.judgments (generation_run_id);
create index judgments_eval_run_id_idx        on public.judgments (eval_run_id);
create index judgments_case_id_idx            on public.judgments (case_id);
create index judgments_stage_id_idx           on public.judgments (stage_id);
create index judgments_artifact_id_idx        on public.judgments (artifact_id);

create table public.expectation_results (
  eval_run_id  uuid        not null references public.eval_runs (id) on delete cascade,
  case_id      uuid        not null,
  judgment_id  uuid        not null references public.judgments (id) on delete cascade,
  matched      boolean     not null,
  detail       text,
  primary key (eval_run_id, judgment_id)
);
create index expectation_results_eval_run_id_idx on public.expectation_results (eval_run_id);

-- ===========================================================================
-- 13. Row Level Security — owner (membership) policies.
-- ===========================================================================
alter table public.workspaces        enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_invites enable row level security;

create policy workspaces_select on public.workspaces
  for select to authenticated
  using (public.is_workspace_member(id));
create policy workspaces_insert on public.workspaces
  for insert to authenticated
  with check (owner_id = public.current_app_user_id());
create policy workspaces_update on public.workspaces
  for update to authenticated
  using (public.is_workspace_admin(id))
  with check (public.is_workspace_admin(id));
create policy workspaces_delete on public.workspaces
  for delete to authenticated
  using (public.is_workspace_admin(id));

create policy workspace_members_select on public.workspace_members
  for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy workspace_members_insert on public.workspace_members
  for insert to authenticated
  with check (public.is_workspace_admin(workspace_id));
create policy workspace_members_update on public.workspace_members
  for update to authenticated
  using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));
create policy workspace_members_delete on public.workspace_members
  for delete to authenticated
  using (public.is_workspace_admin(workspace_id));

create policy workspace_invites_select on public.workspace_invites
  for select to authenticated
  using (public.is_workspace_admin(workspace_id));
create policy workspace_invites_insert on public.workspace_invites
  for insert to authenticated
  with check (public.is_workspace_admin(workspace_id));
create policy workspace_invites_update on public.workspace_invites
  for update to authenticated
  using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));
create policy workspace_invites_delete on public.workspace_invites
  for delete to authenticated
  using (public.is_workspace_admin(workspace_id));

alter table public.projects        enable row level security;
alter table public.assets          enable row level security;
alter table public.asset_edges     enable row level security;
alter table public.selections      enable row level security;
alter table public.actions         enable row level security;
alter table public.jobs            enable row level security;
alter table public.generation_runs enable row level security;
alter table public.idempotency     enable row level security;

create policy projects_owner on public.projects
  for all using (public.owns_workspace(workspace_id)) with check (public.owns_workspace(workspace_id));
create policy assets_owner on public.assets
  for all using (public.owns_workspace(workspace_id) and public.owns_project(project_id))
  with check (public.owns_workspace(workspace_id) and public.owns_project(project_id));
create policy jobs_owner on public.jobs
  for all using (public.owns_workspace(workspace_id) and public.owns_project(project_id))
  with check (public.owns_workspace(workspace_id) and public.owns_project(project_id));
create policy generation_runs_owner on public.generation_runs
  for all using (public.owns_project(project_id)) with check (public.owns_project(project_id));
create policy asset_edges_owner on public.asset_edges
  for all using (public.owns_project(project_id)) with check (public.owns_project(project_id));
create policy selections_owner on public.selections
  for all using (public.owns_project(project_id)) with check (public.owns_project(project_id));
create policy actions_owner on public.actions
  for all using (public.owns_project(project_id)) with check (public.owns_project(project_id));

-- Idempotency: service-role only (RLS on, no policy).

-- Eval entities: service-role only (RLS on, no end-user policy); judgments stays
-- append-only.
alter table public.eval_suites         enable row level security;
alter table public.eval_cases          enable row level security;
alter table public.eval_runs           enable row level security;
alter table public.judgments           enable row level security;
alter table public.expectation_results enable row level security;

-- Inline judgments are reachable through their generation run's project; offline
-- suite judgments (no generation_run_id) remain service-role only.
create policy judgments_owner on public.judgments
  for all using (
    generation_run_id is not null
    and exists (select 1 from public.generation_runs r
                where r.id = judgments.generation_run_id and public.owns_project(r.project_id))
  ) with check (
    generation_run_id is not null
    and exists (select 1 from public.generation_runs r
                where r.id = judgments.generation_run_id and public.owns_project(r.project_id))
  );

revoke update, delete on table public.judgments from public, anon, authenticated;

-- ===========================================================================
-- 14. Public discovery — visibility helpers, indexes, public-read RLS.
-- ===========================================================================
create or replace function public.project_is_public(proj_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.projects p
    where p.id = proj_id
      and p.visibility = 'public'
      and p.status <> 'deleted'
  )
$$;
revoke all on function public.project_is_public(uuid) from public;
grant execute on function public.project_is_public(uuid) to anon, authenticated, service_role;

create or replace function public.asset_is_effectively_public(p_asset_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.assets a
    join public.projects p on p.id = a.project_id
    where a.id = p_asset_id
      and a.visibility = 'public'
      and p.visibility = 'public'
      and p.status <> 'deleted'
  )
$$;
revoke all on function public.asset_is_effectively_public(uuid) from public;
grant execute on function public.asset_is_effectively_public(uuid) to anon, authenticated, service_role;

create or replace function public.generation_run_is_public(p_run_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.generation_runs r
    where r.id = p_run_id
      and public.project_is_public(r.project_id)
  )
$$;
revoke all on function public.generation_run_is_public(uuid) from public;
grant execute on function public.generation_run_is_public(uuid) to anon, authenticated, service_role;

-- Discovery indexes (partial: only public, non-deleted content).
create index projects_visibility_idx on public.projects (visibility)
  where visibility = 'public' and status <> 'deleted';
create index assets_visibility_idx on public.assets (visibility)
  where visibility = 'public';
create index projects_public_feed_idx on public.projects (created_at desc)
  where visibility = 'public' and status <> 'deleted';
create index assets_public_feed_idx on public.assets (created_at desc)
  where visibility = 'public';
-- projects.brief is gone (the brief is a pool asset): project search is by name.
create index projects_search_idx on public.projects
  using gin (to_tsvector('english', coalesce(name, '')))
  where visibility = 'public' and status <> 'deleted';
create index assets_search_idx on public.assets
  using gin (to_tsvector('english',
    coalesce(description, '') || ' ' ||
    coalesce(content ->> 'summary', '') || ' ' ||
    coalesce(context ->> 'summary', '')))
  where visibility = 'public';

create policy projects_public_read on public.projects
  for select to anon, authenticated
  using (visibility = 'public' and status <> 'deleted');
create policy assets_public_read on public.assets
  for select to anon, authenticated
  using (visibility = 'public' and public.project_is_public(project_id));
create policy asset_edges_public_read on public.asset_edges
  for select to anon, authenticated
  using (public.project_is_public(project_id));
create policy selections_public_read on public.selections
  for select to anon, authenticated
  using (public.project_is_public(project_id));
create policy actions_public_read on public.actions
  for select to anon, authenticated
  using (public.project_is_public(project_id));
create policy jobs_public_read on public.jobs
  for select to anon, authenticated
  using (public.project_is_public(project_id));
create policy generation_runs_public_read on public.generation_runs
  for select to anon, authenticated
  using (public.project_is_public(project_id));
create policy judgments_public_read on public.judgments
  for select to anon, authenticated
  using (
    generation_run_id is not null
    and public.generation_run_is_public(generation_run_id)
  );

-- ===========================================================================
-- 15. Tier -> visibility enforcement (function kept, triggers detached).
-- ===========================================================================
-- Until billing tiers exist every user is 'free', so the guard would block the
-- visibility toggle entirely; the projects/assets triggers stay DETACHED
-- (carried over from migration 20260609020000). Re-attach when billing ships.
create or replace function public.enforce_visibility_tier()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_workspace_id uuid;
begin
  if tg_table_name = 'assets' then
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
  else
    target_workspace_id := new.workspace_id;
  end if;

  if new.visibility = 'private'
     and public.owner_tier(target_workspace_id) = 'free'::public.user_tier then
    raise exception 'free tier cannot make content private (workspace %)', target_workspace_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.enforce_visibility_tier() is
  'Tier->visibility guard (free tier cannot set content private). Deliberately '
  'not attached to any trigger in this baseline — public/private is available '
  'to all users until billing tiers ship; re-attach to projects/assets then.';

-- ===========================================================================
-- 16. Public discovery search RPCs (SECURITY DEFINER; bypass RLS by design).
-- ===========================================================================
create or replace function public.search_public_projects(search_query text)
returns setof public.projects
language sql
stable
security definer
set search_path = public
as $$
  select p.*
  from public.projects p
  where p.visibility = 'public'
    and p.status <> 'deleted'
    and to_tsvector('english', coalesce(p.name, ''))
      @@ plainto_tsquery('english', search_query)
  order by p.created_at desc, p.id desc
$$;
revoke all on function public.search_public_projects(text) from public;
grant execute on function public.search_public_projects(text)
  to anon, authenticated, service_role;

create or replace function public.search_public_assets(
  search_query text,
  media_filter public.asset_media default null
)
returns setof public.assets
language sql
stable
security definer
set search_path = public
as $$
  select a.*
  from public.assets a
  join public.projects p on p.id = a.project_id
  where a.visibility = 'public'
    and p.visibility = 'public'
    and p.status <> 'deleted'
    and (media_filter is null or a.media = media_filter)
    and to_tsvector(
      'english',
      coalesce(a.description, '') || ' ' ||
      coalesce(a.content ->> 'summary', '') || ' ' ||
      coalesce(a.context ->> 'summary', '') || ' ' ||
      coalesce(a.context #>> '{agentContext,summary}', '') || ' ' ||
      coalesce(a.semantic_analysis::text, '')
    ) @@ plainto_tsquery('english', search_query)
  order by a.created_at desc, a.id desc
$$;
revoke all on function public.search_public_assets(text, public.asset_media) from public;
grant execute on function public.search_public_assets(text, public.asset_media)
  to anon, authenticated, service_role;

-- ===========================================================================
-- 17. Saved public-asset bookmarks (thin user-owned pointers; no byte copy).
-- ===========================================================================
create table public.saved_assets (
  user_id         uuid not null references public.users (id) on delete cascade,
  source_asset_id uuid not null references public.assets (id) on delete cascade,
  created_at      timestamptz not null default now(),
  primary key (user_id, source_asset_id)
);
create index saved_assets_source_asset_id_idx on public.saved_assets (source_asset_id);

alter table public.saved_assets enable row level security;

create policy saved_assets_select_own on public.saved_assets
  for select to authenticated
  using (user_id = public.current_app_user_id());

-- Bookmarks may only be created for assets that are effectively public.
create policy saved_assets_insert_own on public.saved_assets
  for insert to authenticated
  with check (
    user_id = public.current_app_user_id()
    and public.asset_is_effectively_public(source_asset_id)
  );

create policy saved_assets_delete_own on public.saved_assets
  for delete to authenticated
  using (user_id = public.current_app_user_id());
