-- Orchestrator runs + relational gates + actions.orchestrator_run_id (additive).
--
-- The orchestrator tool-calling loop (docs/scopes/orchestrator-cutover-prs.md, PR 2)
-- needs durable, re-entrant run state: a run is persisted, not a live process, so
-- it can park on an async job / approval gate and resume later. A tool invocation
-- is already modeled by public.actions; this migration adds only the run header and
-- the gate rows, plus a nullable actions.orchestrator_run_id link.
--
-- Applied ON TOP of the existing migration history (never rewrite applied
-- migrations — `supabase db push` diffs the local folder against the remote
-- schema_migrations history and errors on drift). Everything here is additive:
-- two new tables + two new enums + one nullable column on an existing table.

set check_function_bodies = off;

create type orchestrator_run_status as enum
  ('queued', 'running', 'waiting', 'succeeded', 'failed', 'canceled');

-- Gate lifecycle: pending (selected up front) -> reached (the loop arrived at the
-- gated stage and parked) -> approved | rejected (user decided).
create type orchestrator_gate_status as enum
  ('pending', 'reached', 'approved', 'rejected');

-- ---------------------------------------------------------------------------
-- orchestrator_runs — one row per agent-driven generation run.
-- ---------------------------------------------------------------------------
create table public.orchestrator_runs (
  id             uuid primary key default gen_random_uuid(),
  schema_version text                    not null default 'orchestrator_run.v1',
  project_id     uuid                    not null references public.projects (id) on delete cascade,
  status         orchestrator_run_status not null default 'queued',
  input_summary  text                    not null,
  budget_usd     double precision,
  spent_usd      double precision        not null default 0,
  -- Structured error payload (the one JSONB the asset-graph rule allows here).
  error          jsonb,
  created_at     timestamptz             not null default now(),
  updated_at     timestamptz             not null default now(),
  started_at     timestamptz,
  completed_at   timestamptz
);

create index orchestrator_runs_project_id_idx on public.orchestrator_runs (project_id);
create index orchestrator_runs_status_idx on public.orchestrator_runs (status);

-- ---------------------------------------------------------------------------
-- orchestrator_run_gates — user-selected stages to pause before. Relational
-- (not JSONB) because they are user-selected, agent-targeted by name, and
-- user-facing. Zero rows for a run = fully autonomous.
-- ---------------------------------------------------------------------------
create table public.orchestrator_run_gates (
  id                   uuid primary key default gen_random_uuid(),
  orchestrator_run_id  uuid                     not null references public.orchestrator_runs (id) on delete cascade,
  stage                text                     not null,
  status               orchestrator_gate_status not null default 'pending',
  decided_by_action_id uuid                     references public.actions (id) on delete set null,
  decided_at           timestamptz,
  created_at           timestamptz              not null default now(),
  updated_at           timestamptz              not null default now(),
  unique (orchestrator_run_id, stage)
);

create index orchestrator_run_gates_run_id_idx on public.orchestrator_run_gates (orchestrator_run_id);

-- ---------------------------------------------------------------------------
-- actions.orchestrator_run_id — link an invocation to its orchestrator run.
-- Nullable + additive so the staged engine (run_id -> generation_runs) and the
-- orchestrator coexist during the cutover; PR 5 drops generation_runs + run_id.
-- ---------------------------------------------------------------------------
alter table public.actions
  add column orchestrator_run_id uuid references public.orchestrator_runs (id) on delete set null;

create index actions_orchestrator_run_id_idx on public.actions (orchestrator_run_id);

-- ---------------------------------------------------------------------------
-- RLS — project-scoped, mirroring public.actions / public.generation_runs.
-- ---------------------------------------------------------------------------
alter table public.orchestrator_runs      enable row level security;
alter table public.orchestrator_run_gates enable row level security;

create policy orchestrator_runs_owner on public.orchestrator_runs
  for all using (public.owns_project(project_id)) with check (public.owns_project(project_id));
create policy orchestrator_runs_public_read on public.orchestrator_runs
  for select to anon, authenticated
  using (public.project_is_public(project_id));

-- Gates inherit their project scope from the owning run.
create policy orchestrator_run_gates_owner on public.orchestrator_run_gates
  for all using (
    public.owns_project(
      (select r.project_id from public.orchestrator_runs r where r.id = orchestrator_run_id)
    )
  )
  with check (
    public.owns_project(
      (select r.project_id from public.orchestrator_runs r where r.id = orchestrator_run_id)
    )
  );
create policy orchestrator_run_gates_public_read on public.orchestrator_run_gates
  for select to anon, authenticated
  using (
    public.project_is_public(
      (select r.project_id from public.orchestrator_runs r where r.id = orchestrator_run_id)
    )
  );
