# Data model — a one-pager

A high-level map of the Postgres (Supabase) schema for agents: what each table is
**for**, its **column names** (types omitted — infer them), and how the tables
**relate**. Source of truth: `supabase/migrations/` (`20260603000000_init_schema.sql`
+ later migrations). Conventions:

- **PKs are DB-generated `uuid`** (`gen_random_uuid()`); the app no longer mints ids.
- **Loose/churning structures are `jsonb`** (briefs, segments, provenance, edit-graph
  documents, plans, progress, errors, grades). In-JSON ids (beat/scene/segment ids)
  live inside those blobs and are not DB columns.
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
`id, schema_version, workspace_id, name, status, brief, current_brief_version_id, visibility, plan, created_at, updated_at`
→ `workspace_id` → `workspaces`, `current_brief_version_id` → `brief_versions`.
`brief` (current brief jsonb), `plan` (editable storyboard EditPlan: Scenes→Beats, jsonb),
`status` ∈ active|deleted, `visibility` ∈ public|private.

**`brief_versions`** — immutable history of a project's creative brief.
`id, schema_version, project_id, brief, created_at`
→ `project_id` → `projects`.

**`assets`** — uploaded or generated media (video/image/audio) for a project.
`id, schema_version, workspace_id, project_id, kind, status, filename, url, remote_url, storage_key, storage_bucket, source, duration_sec, description, context, semantic_analysis, provenance, generated_asset_job_id, visibility, created_at, updated_at`
→ `workspace_id` → `workspaces`, `project_id` → `projects`. `kind` ∈ video|image|audio;
bytes live in Supabase Storage (`storage_key`/`storage_bucket`); `source`/`context`/
`provenance`/`semantic_analysis` are jsonb metadata.

**`saved_assets`** — user bookmarks pointing at public assets (no byte copy).
`user_id, source_asset_id, created_at`
→ `user_id` → `users`, `source_asset_id` → `assets`. PK = (user_id, source_asset_id).

---

## 3. Composition, timeline & jobs

**`compositions`** — the planned structure of a video (beats + generation plan) for a project.
`id, schema_version, project_id, brief_version_id, mode, status, planned_beats, generated_asset_job_ids, ready_asset_ids, narration_strategy, created_at, updated_at`
→ `project_id` → `projects`, `brief_version_id` → `brief_versions`.
`mode` ∈ asset_driven|prompt_only|hybrid; jsonb arrays hold planned beats / job ids / ready asset ids.

**`edit_graphs`** — the full EditGraphDocument (nodes/edges + timeline projection + provenance) for a project.
`id, schema_version, project_id, brief_version_id, composition_id, document, created_at, updated_at`
→ `project_id` → `projects`, `brief_version_id` → `brief_versions`, `composition_id` → `compositions`.
`document` is the whole graph as jsonb (internal node ids live inside it).

**`timelines`** — a concrete, renderable timeline (segments + render settings) derived from a composition.
`id, schema_version, project_id, brief_version_id, composition_id, aspect_ratio, fps, show_captions, segments, provenance, derived_from, created_by, created_at`
→ `project_id` → `projects`, `brief_version_id` → `brief_versions`, `composition_id` → `compositions`.
`segments` (jsonb) is what Remotion renders.

**`jobs`** — async work units (asset ingest/generation, composition, generation, revision, export, audio).
`id, schema_version, workspace_id, project_id, request_id, type, status, progress, input, result, error, idempotency_key, created_at, updated_at`
→ `workspace_id` → `workspaces`, `project_id` → `projects`. `status` ∈ queued|running|succeeded|failed|canceled.

---

## 4. Generation pipeline (live runs)

A **run** is one end-to-end generation, broken into ordered **stages**, each with
per-item work and addressable output **artifacts**. This is the progress/UI + eval
substrate.

**`generation_runs`** — one generation attempt for a project; the top-level progress aggregate.
`id, project_id, brief_version_id, status, review_gates, review_gate, current_stage_type, progress_percent, message, error, created_at, updated_at, started_at, completed_at`
→ `project_id` → `projects`, `brief_version_id` → `brief_versions`.

**`generation_stages`** — an ordered stage within a run (brief_intake, creative_plan,
storyboard, asset_generation, audio_generation, timeline_assembly, quality_review, export, ready).
`id, run_id, type, label, order, status, is_review_gate, reviewed_at, progress_percent, message, started_at, completed_at, job_ids, artifact_ids, error, judgment, created_at, updated_at`
→ `run_id` → `generation_runs`. `judgment` = inline eval verdict (jsonb).

**`generation_stage_items`** — per-beat/child item of a stage (one card in the UI).
`id, stage_id, kind, label, status, progress_percent, provider, prompt_preview, asset_id, artifact_id, retryable, error, judgment, created_at, updated_at`
→ `stage_id` → `generation_stages`, `asset_id` → `assets`. `kind` ∈ image|video|audio|caption|timeline|export.

**`generation_stage_artifacts`** — the persisted output of a stage/item (the plan, the
assembled timeline, …), so an evaluator can read it as evidence.
`id, run_id, stage_id, item_id, kind, content, created_at`
→ `run_id` → `generation_runs`, `stage_id` → `generation_stages`, `item_id` → `generation_stage_items`.
`content` = the artifact bytes/structure (jsonb).

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
                                         │  projects ──< brief_versions
                                         │     │  ├──< assets >── saved_assets
                                         │     │  ├──< compositions ──< edit_graphs
                                         │     │  │                 └─< timelines
                                         │     │  ├──< jobs
                                         │     │  └──< generation_runs
                                         │     │           └──< generation_stages
                                         │     │                   └──< generation_stage_items
                                         │     │           └──< generation_stage_artifacts
                                         ▼     ▼
                                    (publicly readable when visibility='public')

eval_suites ──< eval_cases                judgments ── point at either a
       └──────< eval_runs ──< expectation_results       generation_run (inline)
                                  └── judgments          OR an eval_run/case (offline)
```

**How a generation flows:** `projects` → a `generation_runs` row → ordered
`generation_stages` → `generation_stage_items` (per beat) → each stage persists a
`generation_stage_artifacts` row. A `judgments` row may attach to any run/stage/item
(inline) or to an `eval_run`/`eval_case` (offline suite). The final renderable output
is a `timelines` row (from a `composition`/`edit_graph`), which Remotion renders.
