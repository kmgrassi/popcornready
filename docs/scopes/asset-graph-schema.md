# Asset-graph schema — migration-ready draft (North Star P1)

> **Status:** Draft for review. **Do not apply yet.** This is the concrete schema
> for [NORTH_STAR.md](../NORTH_STAR.md) §5 ("Target data model") — the immutable
> project-scoped asset pool, dependency/provenance edges, moving selections, and
> the agent action log. All §8 design decisions are treated as constraints.
> When this ships as a migration, mint a **fresh, unique timestamp** (parallel
> agents have collided on versions before) and verify it applied via the
> Management API. Last updated 2026-06-10.

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

### 3.2 `assets` — the pool (transform of the existing table)

Final shape (existing columns kept: `workspace_id`, `project_id`, `status`,
`url`, `remote_url`, `storage_key`, `storage_bucket`, `source`, `duration_sec`,
`description`, `context`, `semantic_analysis`, `visibility`, timestamps).
`filename` becomes nullable (meaningless for data kinds). Dropped:
`provenance`, `generated_asset_job_id` (subsumed by `inputs` / `created_by_action_id`),
and the old `kind asset_kind` (split into `kind graph_asset_kind` + `media`).

```sql
alter table public.assets
  alter column filename drop not null,
  add column ref                  text,
  add column lineage_id           uuid    not null default gen_random_uuid(),
  add column version              integer not null default 1,
  add column media                asset_media,
  -- what it depicts / is for: 'hero', 'beat:opening', 'background-music', ...
  add column role                 text,
  -- the body of data kinds (brief text, beat fields, composite child summary, ...)
  add column content              jsonb,
  -- generation request: { provider, model, prompt, providerPrompt, seed, ... }
  add column params               jsonb,
  -- write-once snapshot of inputs, mirrored to asset_edges by trigger:
  -- [{ assetId, relation, role?, position?, contentHash }]
  add column inputs               jsonb   not null default '[]'::jsonb,
  -- hash of this asset's own semantic content (media: set when bytes land)
  add column content_hash         text,
  -- hash over sorted (inputs[].contentHash) + hash(params): the staleness signal
  add column inputs_fingerprint   text,
  add column created_by_action_id uuid    references public.actions (id) on delete set null;

-- (backfill old rows + drop/rename old kind column — see §5 transform steps —
--  then:)
alter table public.assets
  alter column media set not null,
  alter column kind  set not null;   -- new graph_asset_kind column, post-rename

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
begin
  for e in select * from jsonb_array_elements(coalesce(new.inputs, '[]'::jsonb))
  loop
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

```sql
alter table public.generation_runs
  drop column brief_version_id,
  drop column review_gates,
  drop column review_gate,
  drop column current_stage_type,
  add column budget_usd double precision,
  -- opt-in pause points, by tool name (stops are opt-in, Principle 2):
  add column gates jsonb not null default '[]'::jsonb;
-- kept: id, project_id, status, progress_percent, message, error, timestamps
```

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
    'assets', coalesce((
      select jsonb_agg(jsonb_build_object(
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
    'selections', coalesce((
      select jsonb_agg(jsonb_build_object(
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

(`assets` keeps its existing owner + public-read policies and the
tier→visibility trigger unchanged.)

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
loose `stage_id` pointers, which referenced the stage enum (see §5 step 8).

## 5. Transform path (one migration, clean break)

Dev-stage data: identity, workspaces, projects, jobs, eval, and uploaded assets
are preserved; in-flight creative state (compositions/edit graphs/timelines) is
**not ported** — projects regenerate under the new engine. No compat shims.

1. Create enums (§3.0) and `actions` (§3.1).
2. Drop `search_public_assets(text, asset_kind)` (depends on the old `kind`).
3. `assets`: add new columns; backfill
   `media := kind::text::asset_media`;
   `kind_v2 := case when source ->> 'type' = 'generated' then` (video→`clip`,
   image→`keyframe`, audio→`audio_track`) `else 'source_footage' end`;
   `ref` via the trigger expression; drop old `kind`; rename `kind_v2 → kind`;
   set not-nulls; add constraints, indexes, triggers (§3.2). Drop `provenance`,
   `generated_asset_job_id`.
4. Create `asset_edges` (§3.3), `selections` + view (§3.4).
5. Graph functions (§3.6), RLS (§3.7).
6. Recreate asset search RPC against `media` / `kind` / `content`.
7. Slim `generation_runs` (§3.5).
8. Drop `generation_stage_artifacts`, `generation_stage_items`,
   `generation_stages`, `timelines`, `edit_graphs`, `compositions`,
   `brief_versions` (drop `projects.current_brief_version_id` FK first), then
   `projects.brief`, `projects.plan`. Convert `eval_runs.stop_after` to `text`
   (`using stop_after::text`), then drop enums `generation_stage_type`,
   `stage_item_kind`, `composition_mode`, `composition_status`, `asset_kind`.
9. Add `'agent_action'`-adjacent job types only if needed — `job_type` keeps
   working as-is; `actions.job_ids` links the two.

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
- Remotion render input: a pure compile of the active `cut` composite
  (children + trims live in each child edge's `role`/`position` plus the
  child asset's `content`).

## 7. Open questions (decide at PR time, none block the DDL)

1. **Trim/offset placement.** A segment's `sourceInSec`/`sourceOutSec`: on the
   composite's `content` (recommended — keeps edges pure ordering) vs. as edge
   attributes. Draft assumes composite `content` holds per-child render hints
   keyed by position.
2. **Workspace-level pool promotion** (recurring character across projects) —
   explicitly deferred by North Star §8; the schema doesn't preclude it
   (`workspace_id` already on every asset).
3. **`current_selections` materialization.** The `distinct on` view is fine at
   project scale; revisit only if manifest reads show up in profiles.
