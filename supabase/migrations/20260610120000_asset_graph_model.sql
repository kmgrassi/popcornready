-- Asset-graph data model (North Star P1) — additive clean-break migration.
--
-- Applied ON TOP of the existing migration history (never rewrite applied
-- migrations — the 20260609000000 stub documents why: `supabase db push` diffs
-- the local folder against the remote schema_migrations history and errors on
-- drift). The database is effectively empty (verify before landing — guard
-- step in docs/scopes/asset-graph-schema.md §5), so the retired tables are
-- dropped outright with no data port, and `assets` is recreated fresh.
--
-- Retires (the forward-only pipeline the North Star forbids):
--   compositions, edit_graphs, timelines, brief_versions,
--   generation_stages, generation_stage_items, generation_stage_artifacts,
--   projects.brief/plan/current_brief_version_id,
--   generation_runs.{brief_version_id, review_gates, review_gate,
--                    current_stage_type, review_feedback},
--   enums asset_kind, composition_mode, composition_status,
--         generation_stage_type, stage_item_kind.
--
-- Replaces them with (full rationale: docs/scopes/asset-graph-schema.md):
--   assets       — ONE immutable, project-scoped pool for every artifact kind
--                  (source footage, brief, beats, anchors, keyframes, clips,
--                  audio, critiques, plan, composites/the cut, renders).
--                  Editing inserts a new version sharing lineage_id.
--   asset_edges  — the dependency/provenance graph, trigger-synced from each
--                  asset's write-once `inputs` snapshot; acyclic by
--                  construction; strictly intra-project.
--   selections   — append-only active pointers per slot; per-slot seq is the
--                  compare-and-set token for parallel agents.
--   actions      — the agent decision log (tool, inputs, rationale,
--                  proposal/approval, cost).
--   generation_runs — slimmed to a session/budget grouping over actions.

set check_function_bodies = off;

-- ===========================================================================
-- A. Retire the old model.
-- ===========================================================================
-- A.1 The assets-returning search RPC: its setof return type blocks
-- `drop table assets` below.
drop function if exists public.search_public_assets(text, public.asset_kind);

-- A.2 Generation stage tables (children first). Progress becomes a UI
-- projection over actions + jobs; artifacts become pool assets. The stage
-- visibility helper drops AFTER the tables — their public-read policies
-- depend on it.
drop table if exists public.generation_stage_artifacts;
drop table if exists public.generation_stage_items;
drop table if exists public.generation_stages;
drop function if exists public.generation_stage_is_public(uuid);

-- A.3 The timeline/edit-graph/composition stack: the cut is a composite asset;
-- the edit graph is asset_edges + actions; the composition plan is a plan asset.
drop table if exists public.timelines;
drop table if exists public.edit_graphs;
drop table if exists public.compositions;

-- A.4 The old asset pool and its bookmarks (both recreated below).
drop table if exists public.saved_assets;
drop table if exists public.assets;

-- A.5 generation_runs slims to a session/budget grouping. Gates are opt-in
-- pause points by tool name (stops are opt-in, North Star Principle 2);
-- review feedback flows through actions.
alter table public.generation_runs
  drop column brief_version_id,
  drop column review_gates,
  drop column review_gate,
  drop column current_stage_type,
  drop column review_feedback;
alter table public.generation_runs
  add column budget_usd double precision,
  add column gates jsonb not null default '[]'::jsonb;

-- A.6 Briefs and plans move into the pool. (Dropping `brief` also drops the
-- projects_search_idx expression index — recreated name-only in section I.)
alter table public.projects
  drop column current_brief_version_id,
  drop column brief,
  drop column plan;
drop table if exists public.brief_versions;

-- A.7 eval_runs.stop_after loses its enum type: now loose text naming the
-- tool/checkpoint after which an eval run stops.
alter table public.eval_runs
  alter column stop_after type text using stop_after::text;

-- A.8 Retired enums. (job_type's 'composition'/'revision' values stay —
-- Postgres cannot drop enum values in place; they are harmless orphans.)
drop type if exists public.generation_stage_type;
drop type if exists public.stage_item_kind;
drop type if exists public.composition_mode;
drop type if exists public.composition_status;
drop type if exists public.asset_kind;

-- ===========================================================================
-- B. New enums.
-- ===========================================================================
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

-- ===========================================================================
-- C. Actions — the agent decision log.
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
-- D. Assets — the one immutable, project-scoped pool.
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
  -- media delivery + analysis (same semantics as the old table)
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

-- Re-attach the workspace<->project consistency check to the new table
-- (function exists since 20260609020000; the old trigger died with the table).
create trigger assets_workspace_consistency
  before insert or update of workspace_id, project_id on public.assets
  for each row execute function public.enforce_asset_workspace_consistency();

-- NOTE: the tier->visibility triggers stay DETACHED (20260609020000 dropped
-- them so all users can toggle public/private until billing tiers ship).

-- ===========================================================================
-- E. Asset edges — the dependency/provenance graph.
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
-- F. Selections — append-only active pointers per slot.
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
-- G. Graph queries.
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
-- H. Row Level Security for the new tables.
-- ===========================================================================
alter table public.assets      enable row level security;
alter table public.asset_edges enable row level security;
alter table public.selections  enable row level security;
alter table public.actions     enable row level security;

create policy assets_owner on public.assets
  for all using (public.owns_workspace(workspace_id) and public.owns_project(project_id))
  with check (public.owns_workspace(workspace_id) and public.owns_project(project_id));
create policy asset_edges_owner on public.asset_edges
  for all using (public.owns_project(project_id)) with check (public.owns_project(project_id));
create policy selections_owner on public.selections
  for all using (public.owns_project(project_id)) with check (public.owns_project(project_id));
create policy actions_owner on public.actions
  for all using (public.owns_project(project_id)) with check (public.owns_project(project_id));

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

-- ===========================================================================
-- I. Public discovery — recreate what died with the old objects.
-- ===========================================================================
-- (asset_is_effectively_public/project_is_public/generation_run_is_public
-- survive unchanged: their bodies reference the new assets table by name.)
create index assets_visibility_idx on public.assets (visibility)
  where visibility = 'public';
create index assets_public_feed_idx on public.assets (created_at desc)
  where visibility = 'public';
create index assets_search_idx on public.assets
  using gin (to_tsvector('english',
    coalesce(description, '') || ' ' ||
    coalesce(content ->> 'summary', '') || ' ' ||
    coalesce(context ->> 'summary', '')))
  where visibility = 'public';

-- projects.brief is gone (the brief is a pool asset): project search is by
-- name. (The old expression index died with the column.)
create index projects_search_idx on public.projects
  using gin (to_tsvector('english', coalesce(name, '')))
  where visibility = 'public' and status <> 'deleted';

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
-- J. Saved public-asset bookmarks (recreated; definition unchanged).
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
