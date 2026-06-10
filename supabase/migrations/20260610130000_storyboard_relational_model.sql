-- Storyboard relational model.
--
-- The asset graph remains the provenance spine. Storyboards are a first-class
-- product surface, so their user-facing structure lives in relational rows
-- instead of loosely typed asset.content JSONB.
--
-- Integrity model:
--   * project_id is denormalized onto every storyboard table. Composite FKs
--     chain child -> parent on (project_id, parent_id), so a scene can never
--     belong to another project's storyboard, and every asset link uses a
--     composite FK to assets (project_id, id) — a storyboard in project A can
--     never reference project B's assets (same invariant as asset_edges /
--     selections, see 20260610125000).
--   * The relational row is the MUTABLE HEAD; the linked asset lineage is its
--     history. Once a beat has entered the graph (beat_asset_id set), semantic
--     edits must mint a new beat snapshot asset and move beat_asset_id in the
--     same write — enforced by trigger — so fingerprints change and
--     downstream_assets() can compute the stale candidate set (North Star §5).
--   * Panel selection is owned by storyboard_panels.is_selected (one per beat,
--     partial unique index). The `selections` table is for asset-lineage slots
--     (active cut, active version), NOT panels — one source of truth each.

create type storyboard_status as enum (
  'draft',
  'generating',
  'ready',
  'reviewing',
  'approved',
  'archived'
);

create type storyboard_item_status as enum (
  'draft',
  'queued',
  'generating',
  'ready',
  'approved',
  'rejected',
  'failed'
);

create table public.storyboards (
  id                   uuid primary key default gen_random_uuid(),
  project_id           uuid not null references public.projects (id) on delete cascade,
  plan_asset_id        uuid,
  status               storyboard_status not null default 'draft',
  created_by_action_id uuid references public.actions (id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  -- composite-FK target for the scene -> storyboard chain
  constraint storyboards_project_id_id_unique unique (project_id, id),
  -- plan snapshot must live in the same project
  constraint storyboards_plan_asset_fk foreign key (project_id, plan_asset_id)
    references public.assets (project_id, id) on delete set null (plan_asset_id)
);

create index storyboards_project_idx on public.storyboards (project_id, created_at desc);
create index storyboards_plan_asset_idx on public.storyboards (plan_asset_id);

create trigger storyboards_set_updated_at
  before update on public.storyboards
  for each row execute function public.set_updated_at();

create table public.storyboard_scenes (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null,
  storyboard_id  uuid not null,
  scene_index    integer not null,
  title          text,
  summary        text,
  setting        text,
  mood           text,
  duration_sec   double precision,
  scene_asset_id uuid,
  status         storyboard_item_status not null default 'draft',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint storyboard_scenes_scene_index_nonnegative check (scene_index >= 0),
  constraint storyboard_scenes_duration_nonnegative check (
    duration_sec is null or duration_sec >= 0
  ),
  -- chain FK: the scene's project is its storyboard's project, declaratively
  constraint storyboard_scenes_storyboard_fk foreign key (project_id, storyboard_id)
    references public.storyboards (project_id, id) on delete cascade,
  constraint storyboard_scenes_project_id_id_unique unique (project_id, id),
  constraint storyboard_scenes_scene_asset_fk foreign key (project_id, scene_asset_id)
    references public.assets (project_id, id) on delete set null (scene_asset_id)
);

create unique index storyboard_scenes_order_idx
  on public.storyboard_scenes (storyboard_id, scene_index);
create index storyboard_scenes_storyboard_idx
  on public.storyboard_scenes (storyboard_id);
create index storyboard_scenes_scene_asset_idx
  on public.storyboard_scenes (scene_asset_id);

create trigger storyboard_scenes_set_updated_at
  before update on public.storyboard_scenes
  for each row execute function public.set_updated_at();

create table public.storyboard_beats (
  id                 uuid not null primary key default gen_random_uuid(),
  project_id         uuid not null,
  scene_id           uuid not null,
  beat_index         integer not null,
  intent             text not null default '',
  visual_description text,
  dialogue_summary   text,
  narration          text,
  duration_sec       double precision,
  status             storyboard_item_status not null default 'draft',
  beat_asset_id      uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint storyboard_beats_beat_index_nonnegative check (beat_index >= 0),
  constraint storyboard_beats_duration_nonnegative check (
    duration_sec is null or duration_sec >= 0
  ),
  constraint storyboard_beats_scene_fk foreign key (project_id, scene_id)
    references public.storyboard_scenes (project_id, id) on delete cascade,
  constraint storyboard_beats_project_id_id_unique unique (project_id, id),
  constraint storyboard_beats_asset_fk foreign key (project_id, beat_asset_id)
    references public.assets (project_id, id) on delete set null (beat_asset_id)
);

create unique index storyboard_beats_order_idx
  on public.storyboard_beats (scene_id, beat_index);
create index storyboard_beats_scene_idx
  on public.storyboard_beats (scene_id);
create index storyboard_beats_asset_idx
  on public.storyboard_beats (beat_asset_id);

create trigger storyboard_beats_set_updated_at
  before update on public.storyboard_beats
  for each row execute function public.set_updated_at();

-- The mutable-head/snapshot contract (North Star §5): once a beat has lineage
-- (beat_asset_id set), a semantic edit must arrive together with a NEW
-- beat_asset_id (the freshly minted snapshot asset, same lineage_id) — that is
-- what moves fingerprints and makes the stale candidate set computable.
-- Drafting before first lineage (beat_asset_id null) stays free-form.
create or replace function public.storyboard_beats_require_snapshot()
returns trigger
language plpgsql
as $$
begin
  if (new.intent                is distinct from old.intent
      or new.visual_description is distinct from old.visual_description
      or new.dialogue_summary   is distinct from old.dialogue_summary
      or new.narration          is distinct from old.narration
      or new.duration_sec       is distinct from old.duration_sec)
     and old.beat_asset_id is not null
     and (new.beat_asset_id is null or new.beat_asset_id = old.beat_asset_id)
  then
    raise exception 'semantic beat edits must mint a new beat snapshot asset and update beat_asset_id in the same write'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger storyboard_beats_require_snapshot
  before update on public.storyboard_beats
  for each row execute function public.storyboard_beats_require_snapshot();

create table public.storyboard_panels (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null,
  beat_id         uuid not null,
  panel_index     integer not null default 0,
  image_asset_id  uuid,
  prompt_asset_id uuid,
  status          storyboard_item_status not null default 'queued',
  is_selected     boolean not null default false,
  approved_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint storyboard_panels_panel_index_nonnegative check (panel_index >= 0),
  constraint storyboard_panels_beat_fk foreign key (project_id, beat_id)
    references public.storyboard_beats (project_id, id) on delete cascade,
  constraint storyboard_panels_image_asset_fk foreign key (project_id, image_asset_id)
    references public.assets (project_id, id) on delete set null (image_asset_id),
  constraint storyboard_panels_prompt_asset_fk foreign key (project_id, prompt_asset_id)
    references public.assets (project_id, id) on delete set null (prompt_asset_id)
);

create unique index storyboard_panels_order_idx
  on public.storyboard_panels (beat_id, panel_index);
create unique index storyboard_panels_selected_idx
  on public.storyboard_panels (beat_id)
  where is_selected;
create index storyboard_panels_beat_idx
  on public.storyboard_panels (beat_id);
create index storyboard_panels_image_asset_idx
  on public.storyboard_panels (image_asset_id);
create index storyboard_panels_prompt_asset_idx
  on public.storyboard_panels (prompt_asset_id);

create trigger storyboard_panels_set_updated_at
  before update on public.storyboard_panels
  for each row execute function public.set_updated_at();

comment on table public.storyboards is
  'First-class storyboard product object. The plan_asset_id points to the immutable asset snapshot/provenance record.';
comment on table public.storyboard_scenes is
  'Ordered user-facing scenes for a storyboard; not stored as loose JSONB.';
comment on table public.storyboard_beats is
  'Ordered user-facing beats/shots inside a scene — the mutable head. beat_asset_id is the immutable snapshot lineage; semantic edits must move it (see storyboard_beats_require_snapshot).';
comment on table public.storyboard_panels is
  'Storyboard sketch/preview panels for a beat. Image and prompt remain assets; this table owns UI selection/status — is_selected is the single source of truth for the chosen panel.';

-- Typed JSONB guardrails. Existing rows are not scanned, but new rows must use
-- explicit schema markers for primary document payloads. generation_runs.gates
-- is intentionally excluded until the temporary v1 compatibility bridge is gone.
alter table public.assets
  add constraint assets_content_schema_check
  check (
    content is null
    or (
      jsonb_typeof(content) = 'object'
      and (content ? 'schema' or content ? 'schema_version')
    )
  ) not valid;

alter table public.assets
  add constraint assets_params_schema_check
  check (
    params is null
    or params = '{}'::jsonb
    or (
      jsonb_typeof(params) = 'object'
      and (params ? 'schema' or params ? 'schema_version')
    )
  ) not valid;

alter table public.actions
  add constraint actions_params_schema_check
  check (
    params = '{}'::jsonb
    or (
      jsonb_typeof(params) = 'object'
      and (params ? 'schema' or params ? 'schema_version')
    )
  ) not valid;

alter table public.actions
  add constraint actions_proposal_schema_check
  check (
    proposal is null
    or (
      jsonb_typeof(proposal) = 'object'
      and (proposal ? 'schema' or proposal ? 'schema_version')
    )
  ) not valid;

alter table public.actions
  add constraint actions_error_schema_check
  check (
    error is null
    or (
      jsonb_typeof(error) = 'object'
      and (error ? 'schema' or error ? 'schema_version')
    )
  ) not valid;

alter table public.storyboards enable row level security;
alter table public.storyboard_scenes enable row level security;
alter table public.storyboard_beats enable row level security;
alter table public.storyboard_panels enable row level security;

-- project_id on every row makes RLS a flat check — no exists-joins up the tree.
create policy storyboards_owner on public.storyboards
  for all using (public.owns_project(project_id))
  with check (public.owns_project(project_id));
create policy storyboard_scenes_owner on public.storyboard_scenes
  for all using (public.owns_project(project_id))
  with check (public.owns_project(project_id));
create policy storyboard_beats_owner on public.storyboard_beats
  for all using (public.owns_project(project_id))
  with check (public.owns_project(project_id));
create policy storyboard_panels_owner on public.storyboard_panels
  for all using (public.owns_project(project_id))
  with check (public.owns_project(project_id));

create policy storyboards_public_read on public.storyboards
  for select to anon, authenticated
  using (public.project_is_public(project_id));
create policy storyboard_scenes_public_read on public.storyboard_scenes
  for select to anon, authenticated
  using (public.project_is_public(project_id));
create policy storyboard_beats_public_read on public.storyboard_beats
  for select to anon, authenticated
  using (public.project_is_public(project_id));
create policy storyboard_panels_public_read on public.storyboard_panels
  for select to anon, authenticated
  using (public.project_is_public(project_id));

-- Include relational storyboard structure in the agent's project manifest. The
-- asset list still carries provenance; this gives agents/UI a typed product
-- view without reconstructing scenes/beats/panels from generic graph nodes.
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
    ),
    'storyboards', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', sb.id,
        'status', sb.status,
        'planAsset', (select ref from public.assets where id = sb.plan_asset_id),
        'scenes', (
          select coalesce(jsonb_agg(jsonb_build_object(
            'id', ss.id,
            'index', ss.scene_index,
            'title', ss.title,
            'summary', ss.summary,
            'setting', ss.setting,
            'mood', ss.mood,
            'durationSec', ss.duration_sec,
            'status', ss.status,
            'sceneAsset', (select ref from public.assets where id = ss.scene_asset_id),
            'beats', (
              select coalesce(jsonb_agg(jsonb_build_object(
                'id', b.id,
                'index', b.beat_index,
                'intent', b.intent,
                'visualDescription', b.visual_description,
                'dialogueSummary', b.dialogue_summary,
                'narration', b.narration,
                'durationSec', b.duration_sec,
                'status', b.status,
                'beatAsset', (select ref from public.assets where id = b.beat_asset_id),
                'panels', (
                  select coalesce(jsonb_agg(jsonb_build_object(
                    'id', p.id,
                    'index', p.panel_index,
                    'status', p.status,
                    'selected', p.is_selected,
                    'approvedAt', p.approved_at,
                    'imageAsset', (select ref from public.assets where id = p.image_asset_id),
                    'promptAsset', (select ref from public.assets where id = p.prompt_asset_id)
                  ) order by p.panel_index), '[]'::jsonb)
                  from public.storyboard_panels p
                  where p.beat_id = b.id
                )
              ) order by b.beat_index), '[]'::jsonb)
              from public.storyboard_beats b
              where b.scene_id = ss.id
            )
          ) order by ss.scene_index), '[]'::jsonb)
          from public.storyboard_scenes ss
          where ss.storyboard_id = sb.id
        )
      ) order by sb.created_at), '[]'::jsonb)
      from public.storyboards sb
      where sb.project_id = p_project_id
    )
  )
$$;
