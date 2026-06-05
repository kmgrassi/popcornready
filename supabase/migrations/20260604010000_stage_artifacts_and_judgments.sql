-- ---------------------------------------------------------------------------
-- Stage Eval Framework — live integration tables.
--
-- 1. generation_stage_artifacts: every stage/item now persists its output as a
--    first-class, addressable artifact (the plan, the assembled timeline, …) so
--    an evaluator can read it as evidence after the producing step succeeds
--    (Stage Eval Framework §3 "Evidence-bearing hook"). The producing stage/item
--    references it via artifact_ids / artifact_id; the bytes live here.
-- 2. judgments: the immutable, append-only verdict one AI judge produced on one
--    stage/item output (Stage Eval Framework §3). Inline runs set
--    generation_run_id; offline suite runs set eval_run_id / case_id. Re-judging
--    appends a row.
-- ---------------------------------------------------------------------------

alter table generation_stages add column judgment jsonb;
alter table generation_stage_items add column judgment jsonb;

create table generation_stage_artifacts (
  artifact_id text primary key,
  run_id      text            not null references generation_runs (run_id) on delete cascade,
  stage_id    text            not null references generation_stages (stage_id) on delete cascade,
  item_id     text            references generation_stage_items (item_id) on delete set null,
  kind        stage_item_kind not null,
  content     jsonb           not null,
  created_at  timestamptz     not null default now()
);
create index generation_stage_artifacts_run_id_idx on generation_stage_artifacts (run_id);
create index generation_stage_artifacts_stage_id_idx on generation_stage_artifacts (stage_id);

create table judgments (
  id                 text        primary key,
  evaluator_id       text        not null,
  rubric_version     text        not null,
  judge_model        text        not null,
  generation_run_id  text        references generation_runs (run_id) on delete cascade,
  eval_run_id        text,
  case_id            text,
  stage_id           text        not null,
  item_id            text,
  artifact_id        text,
  asset_id           text,
  grades             jsonb       not null default '{}'::jsonb,
  verdict            text        not null,
  rationale          text        not null default '',
  recommended_action text,
  evidence_ref       text,
  trigger            text        not null default 'auto',
  cost_usd           double precision not null default 0,
  latency_ms         double precision not null default 0,
  created_at         timestamptz not null default now()
);
create index judgments_generation_run_id_idx on judgments (generation_run_id);
create index judgments_stage_id_idx on judgments (stage_id);
create index judgments_eval_run_id_idx on judgments (eval_run_id);

alter table generation_stage_artifacts enable row level security;
alter table judgments                  enable row level security;

-- Stage artifacts walk back to the run's project (same shape as stage items).
create policy generation_stage_artifacts_owner on generation_stage_artifacts
  for all using (
    exists (select 1 from generation_runs r
            where r.run_id = generation_stage_artifacts.run_id and owns_project(r.project_id))
  ) with check (
    exists (select 1 from generation_runs r
            where r.run_id = generation_stage_artifacts.run_id and owns_project(r.project_id))
  );

-- Inline judgments are reachable through their generation run's project. Offline
-- suite judgments (no generation_run_id) are admin/service-role only.
create policy judgments_owner on judgments
  for all using (
    generation_run_id is not null
    and exists (select 1 from generation_runs r
                where r.run_id = judgments.generation_run_id and owns_project(r.project_id))
  ) with check (
    generation_run_id is not null
    and exists (select 1 from generation_runs r
                where r.run_id = judgments.generation_run_id and owns_project(r.project_id))
  );
