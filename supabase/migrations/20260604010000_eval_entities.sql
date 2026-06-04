-- Stage eval framework — entity tables.
--
-- Translates the TypeScript persistence contracts in packages/eval/src/types.ts
-- into Postgres:
--   * EvalSuite          -> eval_suites
--   * EvalCase           -> eval_cases
--   * EvalRun            -> eval_runs
--   * Judgment           -> judgments        (append-only / immutable)
--   * ExpectationResult  -> expectation_results
--
-- Design notes (see docs/scopes/stage-eval-framework.md §3, §6):
--   * Eval entities are GLOBAL admin/tooling records, not workspace/project
--     scoped — the data model carries no workspaceId/projectId. They are reached
--     only by the service_role key (RLS on, no policy = service-role only), the
--     same posture used for the `eval` storage bucket.
--   * IDs stay TEXT to match the app's generated id scheme (evalsuite_*,
--     evalcase_*, evalrun_*, judgment_*) and the ids minted by packages/eval.
--   * Timestamps stay timestamptz; the app writes ISO-8601 strings.
--   * Loosely-shaped / still-churning structures (stimulus, expectations,
--     grades, judgeModels, aggregate, evidence) are stored as jsonb.
--   * `judgments` is append-only: re-judging inserts a new row; nothing is
--     updated or deleted (NORTH_STAR principle 9 / asset-pool philosophy).
--   * Graph-node pointers (stage_id/item_id/artifact_id/asset_id) are kept as
--     loose TEXT, not FKs — a Judgment can point at an inline suite artifact that
--     never became a generation_* row, and offline runs have no generation graph.

set check_function_bodies = off;

create type eval_run_source     as enum ('suite', 'manual_workbench');
create type eval_generation_mode as enum ('prompts_only', 'full');
create type eval_run_status     as enum ('queued', 'running', 'succeeded', 'failed');
create type judgment_verdict    as enum ('pass', 'needs_review', 'fail');
create type judgment_trigger    as enum ('auto', 'manual');

-- ---------------------------------------------------------------------------
-- Suites + cases
-- ---------------------------------------------------------------------------
create table eval_suites (
  id          text primary key,
  name        text        not null,
  description text,
  created_at  timestamptz not null default now()
);

create table eval_cases (
  id            text primary key,
  suite_id      text        not null references eval_suites (id) on delete cascade,
  label         text        not null,
  stimulus      jsonb       not null,
  stages_to_run jsonb       not null default '[]'::jsonb,
  expectations  jsonb,
  -- Media artifacts referenced by this case (content-addressed `eval` bucket).
  -- Text artifacts live inline in `stimulus` / here per the runner fixture shape.
  artifacts     jsonb       not null default '[]'::jsonb,
  created_at    timestamptz not null default now()
);
create index eval_cases_suite_id_idx on eval_cases (suite_id);

-- ---------------------------------------------------------------------------
-- Runs
-- ---------------------------------------------------------------------------
create table eval_runs (
  id              text                 primary key,
  source          eval_run_source      not null default 'suite',
  suite_id        text                 references eval_suites (id) on delete set null,
  generation_mode eval_generation_mode not null default 'prompts_only',
  stop_after      generation_stage_type,
  git_sha         text                 not null,
  branch          text                 not null,
  judge_models    jsonb                not null default '{}'::jsonb,
  status          eval_run_status      not null default 'queued',
  aggregate       jsonb,
  created_at      timestamptz          not null default now(),
  completed_at    timestamptz
);
create index eval_runs_suite_id_idx   on eval_runs (suite_id);
create index eval_runs_created_at_idx on eval_runs (created_at desc);

-- ---------------------------------------------------------------------------
-- Judgments (append-only / immutable)
-- ---------------------------------------------------------------------------
create table judgments (
  id                 text             primary key,
  evaluator_id       text             not null,
  rubric_version     text             not null,
  judge_model        text             not null,
  -- exactly one provenance side (inline vs offline) — not constrained here
  -- because an on-demand judge can carry neither when judging a bare artifact.
  generation_run_id  text,
  eval_run_id        text             references eval_runs (id) on delete cascade,
  case_id            text             references eval_cases (id) on delete set null,
  -- graph-node pointers (loose TEXT — may reference inline/offline artifacts)
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
create index judgments_eval_run_id_idx on judgments (eval_run_id);
create index judgments_case_id_idx     on judgments (case_id);
create index judgments_artifact_id_idx on judgments (artifact_id);

-- ---------------------------------------------------------------------------
-- Expectation results (meta-eval: did the judge match the case's expectation?)
-- ---------------------------------------------------------------------------
create table expectation_results (
  eval_run_id  text        not null references eval_runs (id) on delete cascade,
  case_id      text        not null,
  judgment_id  text        not null references judgments (id) on delete cascade,
  matched      boolean     not null,
  detail       text,
  primary key (eval_run_id, judgment_id)
);
create index expectation_results_eval_run_id_idx on expectation_results (eval_run_id);

-- ---------------------------------------------------------------------------
-- RLS — eval tooling is service-role only (no end-user policy).
-- ---------------------------------------------------------------------------
-- With RLS enabled and no policy, only the service_role key (used server-side by
-- the eval API) can read/write. Admin gating happens in app code per
-- docs/scopes/auth-app-architecture.md; no anon/public access to eval data.
alter table eval_suites         enable row level security;
alter table eval_cases          enable row level security;
alter table eval_runs           enable row level security;
alter table judgments           enable row level security;
alter table expectation_results enable row level security;

-- judgments are append-only even for the service_role path: revoke UPDATE/DELETE
-- so a bug cannot mutate the immutable verdict history.
revoke update, delete on table judgments from public;
