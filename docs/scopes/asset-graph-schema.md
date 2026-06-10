# Asset-graph schema — design record (North Star P1)

> **Status:** Schema authored. The DDL lives in
> [`supabase/migrations/20260610120000_init_asset_graph.sql`](../../supabase/migrations/20260610120000_init_asset_graph.sql)
> — a **squashed baseline** replacing the previous migration set (§5); this doc
> is the rationale record. **Not yet applied to the linked database** — that
> requires the §5 verify-empty guard, then `supabase db reset --linked`.
> Validated against a scratch Supabase Postgres (migration + seed + functional
> smoke of edges/selections/guards/graph queries). This is the concrete schema
> for [NORTH_STAR.md](../NORTH_STAR.md) §5 ("Target data model") — the immutable
> project-scoped asset pool, dependency/provenance edges, moving selections, and
> the agent action log. All §8 design decisions are treated as constraints.
> Last updated 2026-06-10.

## 1. The model in one paragraph

Everything the system produces or ingests — source footage, the brief, **each
beat**, anchors, keyframes, clips, audio, critiques, the plan, the cut, renders —
is an **immutable row in `assets`** (the pool). Rows are **never updated
semantically and never deleted**; editing something inserts a **new version**
sharing a `lineage_id`. **`asset_edges`** records what each asset was built from
(provenance) and what a composite contains (ordered children) — together this is
the dependency graph, and because new rows can only reference existing rows, it
is a DAG by construction. **`selections`** is an append-only log of which asset
is *active* in each slot (active version of a lineage, a beat's active keyframe,
the project's active cut); the current state of a project is just the latest
selection per slot. **`actions`** is the agent's decision log — every tool call
with its inputs (by id), rationale, proposal/approval, and cost — replacing the
edit graph's revision operations and the `Patch` persistence concept. `jobs`
stays as the async execution substrate; `generation_runs` slims down to a
session/budget grouping over actions.

Invariants the schema enforces:

- **Immutability:** semantic columns on `assets` reject UPDATE (guard trigger);
  only lifecycle fields (status, storage pointers, late-arriving analysis) may
  change. DELETE is blocked except for `service_role`.
- **DAG:** edges are written once, in the same transaction as the derived
  asset, from its `inputs` snapshot; the never-delete invariant is enforced by
  the asset delete guard (FKs stay `cascade` so project deletion still works).
- **Append-only selections:** UPDATE/DELETE revoked (same pattern as
  `judgments`); per-slot `seq` is the compare-and-set token for parallel agents.
- **Self-description:** every asset carries `kind`, `role`, `params`
  (prompt/model/seed), `inputs` (what it was built from, by id + content hash),
  `content_hash`, and `inputs_fingerprint` — the agent can reason over the pool
  without reading media.

## 2. Worked example (the §3 gap, closed)

"Edit beat 3" becomes:

1. Agent records an `actions` row (`tool = 'change_beat'`, rationale, pinned
   fingerprints in `proposal`).
2. Insert beat-3 **v2** into `assets` (same `lineage_id`, `version = 2`,
   `created_by_action_id` set).
3. Append a `selections` row flipping the beat-3 lineage's `active` slot to v2.
4. `downstream_assets(beat3_v1.id)` returns the candidate stale set — keyframe 3,
   clip 3, the plan, the cut — **computed from data**, in one recursive query.
5. The candidate set + provenance goes to the agent, which proposes the minimal
   re-run (Principle 5). Cheap data nodes (plan, cut) re-derive automatically;
   expensive ones (clip) wait for approval.
6. Regenerations insert new pool rows and flip slots. Nothing is mutated,
   nothing is lost; beat-3 v1's keyframe stays reusable elsewhere.

## 3. DDL (migration-ready)

Conventions match `20260603000000_init_schema.sql`: DB-generated uuid PKs,
`set_updated_at` trigger, RLS via `owns_project` / `project_is_public`,
append-only via `revoke`.

### 3.0 Enums

```sql
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
```

### 3.1 `actions` — the agent decision log

Created first so `assets.created_by_action_id` and `selections.set_by_action_id`
can reference it.

```sql
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
```

### 3.2 `assets` — the pool (fresh create)

The database holds no data worth porting (§5) and the DDL ships as a squashed
baseline, so the old `assets` shape simply doesn't exist — this is a clean
`create table`, no backfill, no column renames. Versus the old shape:
`kind asset_kind` splits into `kind graph_asset_kind` + `media`; `provenance`
and `generated_asset_job_id` are subsumed by `inputs` /
`created_by_action_id`; `filename` and `source` become nullable (meaningless
for data kinds). The delivery columns (`url`, `storage_key`, `storage_bucket`,
…), `visibility`, and the analysis jsonb columns carry over unchanged.

```sql
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
  -- media delivery + analysis (unchanged semantics from the old table)
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
-- (unique-collision on (project_id, ref) is ~impossible at project scale; the
--  insert errors and the app retries.)

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

-- Nothing is throwaway (Principle 9): deletes are service_role-only
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
```

### 3.3 `asset_edges` — the dependency/provenance graph

Source of truth for *what was built from what*. Written once, by trigger, from
the new asset's `inputs` snapshot — they cannot drift. Direction: `from_id`
(consumer/derived) → `to_id` (consumed/input). A composite may reference the
same child at two positions (a reused scene), hence the surrogate PK.

```sql
create table public.asset_edges (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid          not null references public.projects (id) on delete cascade,
  from_id    uuid          not null references public.assets (id) on delete cascade,
  -- cascade, not restrict: restrict would race the project->assets cascade
  -- (sibling-cascade order is unspecified). The "inputs are never deleted"
  -- invariant lives in assets_guard_delete, not in this FK.
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
    -- Edges are strictly intra-project (decided, §7.2): cross-project reuse is
    -- import-by-copy with the origin recorded in `source`, never a graph edge —
    -- so blast radius and RLS can never leak across projects.
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
```

Because an asset's `inputs` can only name rows that already exist, and edges are
written at insert time, the graph is acyclic by construction — no cycle check
needed.

### 3.4 `selections` — append-only active pointers

A *slot* is identified by `(slot_owner_lineage_id, slot_role)`:

| Slot | owner lineage | role |
|---|---|---|
| Active version of beat 3 | beat-3 lineage | `active` |
| Beat 3's keyframe | beat-3 lineage | `keyframe` |
| Beat 3's clip | beat-3 lineage | `clip` |
| Anchor "Maya"'s image | anchor lineage | `active` |
| The project's plan | `null` (project-scoped) | `plan` |
| The project's cut | `null` | `cut` |

```sql
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

-- Append-only (history IS the undo stack): judgments pattern, but also revoke
-- from anon/authenticated — Supabase grants those roles directly, so revoking
-- only `public` would not actually strip them.
revoke update, delete on table public.selections from public, anon, authenticated;

-- Current state of every slot.
create or replace view public.current_selections
with (security_invoker = on) as
select distinct on (project_id, slot_owner_lineage_id, slot_role) *
from public.selections
order by project_id, slot_owner_lineage_id, slot_role, seq desc;
```

`seq` must be allowed `null` on insert for the trigger default; clients should
**send an explicit `seq` (last seen + 1) when applying a proposal** so the
unique index enforces compare-and-set against the state the proposal was
computed on.

### 3.5 `generation_runs` — slimmed to a session/budget grouping

Created fresh in the baseline (not altered):

```sql
create table public.generation_runs (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid             not null references public.projects (id) on delete cascade,
  status           job_status       not null default 'queued',
  budget_usd       double precision,
  -- opt-in pause points, by tool name (stops are opt-in, Principle 2):
  gates            jsonb            not null default '[]'::jsonb,
  progress_percent double precision,
  message          text,
  error            jsonb,
  created_at       timestamptz      not null default now(),
  updated_at       timestamptz      not null default now(),
  started_at       timestamptz,
  completed_at     timestamptz
);
```

Retired with the old shape: `brief_version_id` (briefs are pool assets),
`review_gates`/`review_gate`/`current_stage_type` (the stage enum is gone), and
`review_feedback` (added by the 20260609 migrations; feedback now flows through
`actions`).

`generation_stages` / `generation_stage_items` / `generation_stage_artifacts`
are **dropped** (§5): stage progress becomes a UI projection over
`actions` + `jobs`, and every artifact is a pool asset — there is no second
artifact store. The hardcoded `generation_stage_type` order was the conveyor
belt the North Star forbids.

### 3.6 Graph queries (the payoff)

```sql
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
-- (SQL function without SECURITY DEFINER -> runs under caller's RLS.)
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
```

**Staleness is computed on read, never stored.** A derived asset is a stale
*candidate* when, for any of its input lineages, the slot's current active
asset's `content_hash` differs from the hash recorded in its `inputs` snapshot.
No `stale` flag, no cascade-update writes — and a flag would imply a command,
where the doc wants a signal.

### 3.7 RLS

```sql
alter table public.asset_edges enable row level security;
alter table public.selections  enable row level security;
alter table public.actions     enable row level security;

create policy asset_edges_owner on public.asset_edges
  for all using (public.owns_project(project_id))
  with check (public.owns_project(project_id));
create policy selections_owner on public.selections
  for all using (public.owns_project(project_id))
  with check (public.owns_project(project_id));
create policy actions_owner on public.actions
  for all using (public.owns_project(project_id))
  with check (public.owns_project(project_id));

-- Public discovery parity with today's tables:
create policy asset_edges_public_read on public.asset_edges
  for select to anon, authenticated
  using (public.project_is_public(project_id));
create policy selections_public_read on public.selections
  for select to anon, authenticated
  using (public.project_is_public(project_id));
create policy actions_public_read on public.actions
  for select to anon, authenticated
  using (public.project_is_public(project_id));
```

Because `assets` is dropped and recreated (§3.2), its security surface is
recreated verbatim from the init schema:

```sql
alter table public.assets enable row level security;

create policy assets_owner on public.assets
  for all using (public.owns_workspace(workspace_id) and public.owns_project(project_id))
  with check (public.owns_workspace(workspace_id) and public.owns_project(project_id));
create policy assets_public_read on public.assets
  for select to anon, authenticated
  using (visibility = 'public' and public.project_is_public(project_id));

-- NOTE: the tier->visibility triggers stay DETACHED — migration 20260609020000
-- deliberately dropped them so all users can toggle public/private until
-- billing tiers ship. enforce_visibility_tier() is kept (unattached) for that
-- day; what IS attached is the tier-agnostic workspace-consistency check it
-- used to provide as a side effect:
create trigger assets_workspace_consistency
  before insert or update of workspace_id, project_id on public.assets
  for each row execute function public.enforce_asset_workspace_consistency();

-- saved_assets: recreate exactly as in the init schema §13 (definition and
-- policies unchanged — it references assets only by id).
```

Discovery artifacts are recreated against the new columns: the partial
visibility/feed indexes verbatim, the search GIN index over
`description || content->>'summary' || context->>'summary'`, and
`search_public_assets(search_query text, media_filter asset_media default null)`
replacing the old `asset_kind`-typed RPC.

## 4. What this replaces

| Today | Where it goes |
|---|---|
| `projects.brief`, `projects.plan`, `brief_versions` | `brief` / `beat` / `plan` pool assets + selections |
| `compositions` (`planned_beats`, `ready_asset_ids`, …) | `plan` asset + per-beat slots + `actions` |
| `edit_graphs.document` (jsonb megalith) | `asset_edges` (queryable rows) + `actions` (rationale/alternatives) |
| `timelines` (+ `VersionedTimeline`) | `composite` assets (`cut_*`); Remotion renders the compiled projection of the active cut |
| `generation_stage_artifacts` | pool assets — one store (Principle 9) |
| `generation_stages` / `_items`, `generation_stage_type` enum | UI view over `actions` + `jobs` |
| `Patch` ops / `EditGraphRevisionOperation` | `actions` rows + new pool versions + selection flips |
| `assets.provenance`, `assets.generated_asset_job_id` | `inputs` / `params` / `created_by_action_id` |

`jobs`, `idempotency`, identity/tenancy, visibility/tier enforcement, and the
eval framework are untouched — except `eval_runs.stop_after` and `judgments`'
loose `stage_id` pointers, which referenced the stage enum (see §5).

## 5. Migration mechanics (empty database — drop, don't port)

The database holds no meaningful rows — no assets, no in-flight creative state
(decided 2026-06-10). So there is **no transform or backfill path**: dead
objects are dropped outright and `assets` is created fresh in its final shape.
**Guard step before landing:** confirm the linked DB is actually disposable —
row counts over `users` / `workspaces` / `projects` / `assets` via the
Management API query endpoint (don't trust a stale assumption).

**Option A (squashed baseline) is what shipped:**
`supabase/migrations/20260610120000_init_asset_graph.sql` replaces the previous
five migration files — the exact precedent of `20260603000000_init_schema.sql`,
which was itself a squash. The dead tables below simply do not exist in it;
future readers never see them. Landing it requires resetting the linked
database (`supabase db reset --linked`), which also wipes `auth.users` — dev
logins re-sign-up. (The rejected alternative was an additive drop-migration:
it would keep history and auth users, but leave the retired tables visible in
past migrations.)

**Dead objects (deleted entirely; nothing references them after this DDL):**

- **Tables:** `compositions`, `edit_graphs`, `timelines`, `brief_versions`,
  `generation_stages`, `generation_stage_items`, `generation_stage_artifacts`;
  plus the old `assets` and `saved_assets` (both recreated fresh, §3.2/§3.7).
- **Columns:** `projects.brief`, `projects.plan`,
  `projects.current_brief_version_id` (drop its FK with `brief_versions`);
  `generation_runs.{brief_version_id, review_gates, review_gate,
  current_stage_type}` (§3.5).
- **Enums:** `asset_kind`, `composition_mode`, `composition_status`,
  `stage_item_kind`, and `generation_stage_type` — convert
  `eval_runs.stop_after` to `text` first (`using stop_after::text`).
- **Functions:** `search_public_assets(text, asset_kind)` (recreated against
  `media`/`kind`/`content`, §3.7).
- **`job_type` enum values** `composition` and `revision` are orphaned
  vocabulary: under option A, recreate the enum without them; under option B,
  leave them (Postgres can't drop enum values in place; they're harmless).

**Kept untouched:** identity/tenancy (`users`, `workspaces`, `workspace_members`,
`workspace_invites`), `projects` (minus the dropped columns), `jobs`,
`idempotency`, the eval framework, and the tier/visibility machinery.

## 6. Code impact (for the PR that lands this)

- `packages/shared`: add `GraphAsset`, `AssetEdge`, `Selection`, `AgentAction`,
  `AssetKind`, `EdgeRelation`; delete `CompositionPlan`, `VersionedTimeline`,
  `VersionedEditGraph`, the whole `edit-graph.ts` module, and `Patch`.
- `apps/api` `V1Store`: collapses to `assets` / `asset_edges` / `selections` /
  `actions` / `jobs` accessors + `projectManifest()` / `downstreamAssets()`
  RPC wrappers.
- Agent functions (`planEdit`, `revise`, …) become tools that read the manifest
  and emit actions + pool inserts; `revise`'s patch output is replaced by the
  regeneration vocabulary (`change_beat`, `swap_selection`, `regenerate_*`,
  `assemble`).
- Remotion render input: a pure compile of the active `cut` composite. Trims,
  captions, and transitions live in the composite's own `content.children[]`
  (keyed by position, decided §7.1); edges carry ordering only, so the renderer
  reads one self-contained document.

## 7. Design questions (all resolved 2026-06-10)

Kept with their resolutions as the design record (North Star §8 pattern); these
are constraints for the implementing PR.

1. ~~**Trim/offset placement**~~ **— DECIDED: composite `content`.** Trims,
   captions, and transitions live in the composite's `content.children[]`,
   keyed by position; edges carry only (child, relation, position). Rationale:
   edges exist for blast radius, and a trim doesn't change what the cut
   *depends on* — it changes what the cut *is*, so `content_hash` is the right
   place for it to register (a re-trim mints a new composite version and the
   render correctly becomes a stale candidate). The renderer reads one
   self-contained document; `asset_edges` stays lean. The write-once
   duplication of the child list between `content` and edges is accepted —
   both derive from the same insert payload on an immutable row, so they
   cannot drift.
2. ~~**Workspace-level pool promotion**~~ **— DECIDED: reuse is by copy, and
   edges are strictly intra-project.** When cross-project reuse arrives
   (recurring character/logo), importing **mints a new immutable row** in the
   target project with the origin recorded in `source` jsonb (the upload
   pattern) — never a cross-project graph edge. By-reference reuse would leak
   blast radius across projects (touching the character in project A would
   stale project B's clips) and break project-scoped RLS/manifest queries.
   Copying is semantically free because pool rows are immutable. A future
   "workspace library" is a bookmark/tag table over assets (the `saved_assets`
   pattern), not a new scope. The edge-sync trigger (§3.3) enforces the
   intra-project invariant today.
3. ~~**`current_selections` materialization**~~ **— DECIDED: plain view +
   covering index.** Selections per project ≈ number of slot flips (hundreds,
   maybe low thousands), so the `distinct on` view over an indexed
   `project_id` filter is more than fast enough; a materialized view would add
   refresh orchestration and make the one table whose job is "current state"
   itself potentially stale. `selections_current_idx` (§3.4) gives the view a
   plain-column path the coalesce-expression CAS index can't provide.
