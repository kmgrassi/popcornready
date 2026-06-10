# Data model — a one-pager

A high-level map of the Postgres (Supabase) schema for agents: what each table is
**for**, its **column names** (types omitted — infer them), and how the tables
**relate**. Source of truth: `supabase/migrations/` (`20260603000000_init_schema.sql`
+ later migrations). Conventions:

- **PKs are DB-generated `uuid`** (`gen_random_uuid()`); the app no longer mints ids.
- **Asset graph is the provenance spine.** `assets`, `asset_edges`,
  `selections`, and `actions` answer what exists, what produced it, what it
  depends on, and which version is active.
- **Product structure is relational.** Stable user-facing concepts such as
  storyboards, scenes, beats, panels, approvals, and future timeline items
  should be rows/columns, not loose JSONB.
- **JSONB is typed edge payload only.** JSONB may hold provider params, raw
  model responses, structured errors, audit/replay snapshots, or temporary
  migration bridges, but payloads must carry `schema` or `schema_version` and be
  validated by server code.
- **Tenancy + RLS:** every app row walks back to an owning **workspace** via
  `workspace_members`; policies key on `current_app_user_id()` (the domain user),
  not `auth.uid()`. Some content is also publicly readable when `visibility='public'`.
  Eval suite tables are service-role only; inline `judgments` follow generation-run
  owner/public-read policies. See `docs/supabase-identity-and-rls.md`.

See also [`repository-structure.md`](repository-structure.md) for where the DB
layer sits in the codebase.

---

## 1. Identity & tenancy

**`users`** — the app/domain user, decoupled from Supabase `auth.users`. Also
carries billing tier.
`id, auth_id, email, full_name, first_name, last_name, avatar_url, metadata, tier, tier_source, tier_changed_at, created_at, updated_at`
→ `auth_id` links to `auth.users` (null until signup). `tier` ∈ free|paid.

**`workspaces`** — the tenancy boundary; everything a user owns hangs off a workspace.
`id, schema_version, owner_id, name, created_at, updated_at`
→ `owner_id` → `users` (null for the seeded local-dev workspace).

**`workspace_members`** — who can access a workspace, and their role (owner|admin|member).
This join table is what RLS checks for access.
`workspace_id, user_id, role, invited_by, created_at, updated_at`
→ `workspace_id` → `workspaces`, `user_id`/`invited_by` → `users`. PK = (workspace_id, user_id).

**`workspace_invites`** — pending invitations into a workspace (by email + token).
`id, workspace_id, email, role, invited_by, token, status, expires_at, accepted_by, accepted_at, created_at, updated_at`
→ `workspace_id` → `workspaces`, `invited_by`/`accepted_by` → `users`. `status` ∈ pending|accepted|revoked|expired.

---

## 2. Projects & content

**`projects`** — a single video project (the main unit of work) inside a workspace.
`id, schema_version, workspace_id, name, status, visibility, created_at, updated_at`
→ `workspace_id` → `workspaces`.
Briefs, plans, and storyboard state are no longer columns on `projects`; they
live as assets plus relational storyboard rows. `status` ∈ active|deleted,
`visibility` ∈ public|private.

**`assets`** — the immutable project-scoped pool for generated/imported
artifacts and typed snapshots.
`id, schema_version, workspace_id, project_id, ref, lineage_id, version, kind, media, status, role, content, params, inputs, content_hash, inputs_fingerprint, created_by_action_id, filename, url, remote_url, storage_key, storage_bucket, source, duration_sec, description, context, semantic_analysis, visibility, created_at, updated_at`
→ `workspace_id` → `workspaces`, `project_id` → `projects`,
`created_by_action_id` → `actions`. `kind` ∈ source_footage|brief|beat|anchor|
keyframe|clip|audio_track|narration_script|critique|plan|composite|render.
`media` ∈ data|image|video|audio. Semantic asset fields are immutable; insert a
new version with the same `lineage_id` to revise.

**`asset_edges`** — dependency/provenance graph, written from asset inputs.
`id, project_id, from_id, to_id, relation, role, position, created_at`
→ `project_id` → `projects`, `from_id`/`to_id` → `assets`. Direction is
consumer/derived asset → consumed/input asset. `relation` ∈ input|anchor|child.

**`selections`** — append-only active pointers per slot.
`id, project_id, slot_owner_lineage_id, slot_role, seq, active_asset_id, set_by_action_id, created_at`
→ `project_id` → `projects`, `active_asset_id` → `assets`,
`set_by_action_id` → `actions`. `current_selections` exposes the latest row per
slot.

**`actions`** — agent/tool decision log.
`id, schema_version, project_id, run_id, tool, status, params, input_asset_ids, rationale, proposal, estimated_cost_usd, actual_cost_usd, job_ids, output_asset_ids, error, created_at, updated_at`
→ `project_id` → `projects`, `run_id` → `generation_runs`. Decision fields are
immutable; lifecycle/cost/output/error fields may update.

**`saved_assets`** — user bookmarks pointing at public assets (no byte copy).
`user_id, source_asset_id, created_at`
→ `user_id` → `users`, `source_asset_id` → `assets`. PK = (user_id, source_asset_id).

---

## 3. Storyboards, composition & jobs

**`storyboards`** — the first-class storyboard product object.
`id, project_id, plan_asset_id, status, active_version, created_by_action_id, created_at, updated_at`
→ `project_id` → `projects`, `plan_asset_id` → `assets`,
`created_by_action_id` → `actions`. `status` ∈ draft|generating|ready|reviewing|
approved|archived.

**`storyboard_scenes`** — ordered scenes in a storyboard.
`id, storyboard_id, scene_index, title, summary, setting, mood, duration_sec, scene_asset_id, status, created_at, updated_at`
→ `storyboard_id` → `storyboards`, `scene_asset_id` → `assets`.

**`storyboard_beats`** — ordered beats/shots in a scene.
`id, scene_id, beat_index, intent, visual_description, dialogue_summary, narration, duration_sec, status, beat_asset_id, created_at, updated_at`
→ `scene_id` → `storyboard_scenes`, `beat_asset_id` → `assets`.

**`storyboard_panels`** — generated or uploaded storyboard panels for a beat.
`id, beat_id, panel_index, image_asset_id, prompt_asset_id, status, is_selected, approved_at, created_at, updated_at`
→ `beat_id` → `storyboard_beats`, `image_asset_id`/`prompt_asset_id` → `assets`.
At most one panel is selected per beat.

**Composite/cut assets** — renderable timeline/cut structure.
There is no `timelines` or `compositions` table in the asset graph model.
Timeline/cut snapshots are `assets.kind = 'composite'`; future high-interaction
timeline tracks/items should become relational tables linked to composite
assets, following the storyboard pattern.

**`jobs`** — async work units (asset ingest/generation, composition, generation, revision, export, audio).
`id, schema_version, workspace_id, project_id, request_id, type, status, progress, input, result, error, idempotency_key, created_at, updated_at`
→ `workspace_id` → `workspaces`, `project_id` → `projects`. `status` ∈ queued|running|succeeded|failed|canceled.

---

## 4. Generation pipeline (live runs)

A **run** is one end-to-end generation session. Progress should be projected from
`actions`, `jobs`, storyboard rows, and assets rather than stored in legacy stage
tables.

**`generation_runs`** — one generation attempt for a project; the top-level progress aggregate.
`id, project_id, status, progress_percent, message, error, created_at, updated_at, started_at, completed_at, budget_usd, gates`
→ `project_id` → `projects`. `gates` is opt-in pause configuration; any v1 stage
state stored there is a temporary compatibility bridge, not the target model.

---

## 5. Eval framework (offline + inline)

Eval suite metadata/results are service-role only (`eval_suites`, `eval_cases`,
`eval_runs`, `expectation_results`, and offline suite `judgments`). Inline
`judgments` set `generation_run_id`, so project owners can read/write them through
`judgments_owner`, and public generation runs expose them through
`judgments_public_read`.

**`eval_suites`** — a named collection of eval cases.
`id, name, description, created_at`

**`eval_cases`** — one test case (stimulus + which stages to run + expectations + fixtures).
`id, suite_id, label, stimulus, stages_to_run, expectations, artifacts, created_at`
→ `suite_id` → `eval_suites`.

**`eval_runs`** — one execution of a suite (or a manual workbench run), with config + aggregate scores.
`id, source, suite_id, generation_mode, stop_after, git_sha, branch, judge_models, status, aggregate, created_at, completed_at`
→ `suite_id` → `eval_suites`. `source` ∈ suite|manual_workbench.

**`judgments`** — append-only AI-judge verdict on one stage/item output. Covers **both**
provenance sides: inline (set `generation_run_id`) and offline suite (set `eval_run_id`/`case_id`).
`id, evaluator_id, rubric_version, judge_model, generation_run_id, eval_run_id, case_id, stage_id, item_id, artifact_id, asset_id, grades, verdict, rationale, recommended_action, evidence_ref, trigger, cost_usd, latency_ms, created_at`
→ `generation_run_id` → `generation_runs`, `eval_run_id` → `eval_runs`, `case_id` → `eval_cases`.
`stage_id`/`item_id`/`artifact_id`/`asset_id` are **loose text pointers (not FKs)** — they may
reference inline or offline artifacts. `verdict` ∈ pass|needs_review|fail. UPDATE/DELETE are revoked.

**`expectation_results`** — meta-eval: did a judgment match the case's expectation?
`eval_run_id, case_id, judgment_id, matched, detail`
→ `eval_run_id` → `eval_runs`, `judgment_id` → `judgments`. PK = (eval_run_id, judgment_id).

---

## 6. Infrastructure

**`idempotency`** — dedup/replay cache for API writes (keyed by scope + key).
`scope, key, body_hash, request_hash, job_id, status, response_body, created_at`
PK = (scope, key). Service-role only.

---

## Relationship overview

```
auth.users ─(auth_id)─ users ─(owner_id)─ workspaces ─< workspace_members >─ users
                          │                    │            (access / RLS)
                          │                    ├─< workspace_invites
                          │ (saved_assets)     │
                          └──────────────┐     ▼
                                         │  projects ──< assets >── saved_assets
                                         │     │  ├──< asset_edges
                                         │     │  ├──< selections/current_selections
                                         │     │  ├──< actions
                                         │     │  ├──< storyboards
                                         │     │  │       └──< storyboard_scenes
                                         │     │  │              └──< storyboard_beats
                                         │     │  │                     └──< storyboard_panels
                                         │     │  ├──< jobs
                                         │     │  └──< generation_runs
                                         ▼     ▼
                                    (publicly readable when visibility='public')

eval_suites ──< eval_cases                judgments ── point at either a
       └──────< eval_runs ──< expectation_results       generation_run (inline)
                                  └── judgments          OR an eval_run/case (offline)
```

**How a generation flows:** `projects` → a `generation_runs` row and `actions`
for tool decisions → relational storyboard rows for user-facing story structure
→ `jobs` for async media work → generated `assets` linked by `asset_edges` and
activated through `selections`. A `judgments` row may attach to a run or loose
artifact pointer. The final renderable output is a selected `composite` asset
or future relational timeline rows compiled for Remotion.
