# Asset graph & storyboard rollout — remaining work (PR plan)

> **Status:** Scope. Written 2026-06-10, immediately after PR #268 (relational
> storyboard model) merged and its migrations applied to the linked database.
> This is the follow-up ledger: what is live, what is schema-ready but unwired,
> and the ordered PRs to close the gap. Companion design records:
> [`asset-graph-schema.md`](asset-graph-schema.md) (the data model) and
> [`../NORTH_STAR.md`](../NORTH_STAR.md) (the target architecture).

## 0. Where things stand (verified against the live DB, 2026-06-10)

**Live in the linked database** (all nine migrations applied; objects verified
via the Management API):

- The asset graph: immutable `assets` pool, `asset_edges`, append-only
  `selections` (+ `current_selections`), `actions`, slimmed `generation_runs`.
- Project-scope integrity: composite same-project FKs on
  `asset_edges`/`selections` (20260610125000) and on every storyboard table.
- The relational storyboard model: `storyboards`, `storyboard_scenes`,
  `storyboard_beats`, `storyboard_panels`, the
  `storyboard_beats_require_snapshot` trigger, and the typed-JSONB check
  constraints (`not valid`).
- Graph queries: `downstream_assets()` and `project_manifest()` (returns nested
  storyboard structure).

**Live in the API** (apps/api):

- Brief/plan persistence as pool assets with selections
  (`insertDataAsset`/`setActiveAssetSelection`, PR #263), now stamping
  `schema_version` markers into `content`/`params` (PR #268 hardening).

**Schema-ready but completely unwired** (zero references in apps/ or packages/
as of this writing):

- The storyboard tables — no store functions, no routes, no UI.
- `asset_edges` — no writer ever populates `inputs`, so no edges exist.
- `content_hash` / `inputs_fingerprint` — no code computes them; staleness is
  uncomputable until they're written.
- `actions` — no code path records agent decisions.
- `downstream_assets()` / `project_manifest()` — no caller.
- `generation_runs.budget_usd` / `gates` — no code honors them.

**Live data caution:** the database is in real use (13 assets, 7 projects).
Nine `media='data'` asset rows predate the schema-marker fix and are
grandfathered by `not valid`. Zero marked rows have been written since the
constraints went live — see the P0 check below.

## P0 — operational check (not a PR; do first)

**Confirm the deployed API includes the #268 writer fix.** The typed-JSONB
check constraints are live in the database *now*. If the Railway API is still
running pre-#268 code, every brief/plan save (`createProject`,
`updateProjectBrief`, `updateProjectPlan`) and every provenance-carrying
`addAsset` fails with a check violation. Verify the deploy timestamp postdates
the #268 merge, then exercise a brief save and confirm the new row's `content`
contains `schema_version`.

## PR 1 — backfill schema markers + validate the JSONB constraints

Small maintenance migration (fresh unique timestamp; never edit applied
migrations):

1. Disable the `assets_guard_immutable` trigger (it blocks `content` updates by
   design).
2. Stamp markers onto the nine legacy rows:
   `content = jsonb_build_object('schema_version','brief.v1') || content` for
   `kind='brief'` (resp. `'plan.v1'` for `kind='plan'`) where the marker is
   missing.
3. Re-enable the trigger.
4. `validate constraint` on all five checks: `assets_content_schema_check`,
   `assets_params_schema_check`, `actions_params_schema_check`,
   `actions_proposal_schema_check`, `actions_error_schema_check`.

Validate against a scratch Supabase Postgres with the full migration chain
before pushing (established pattern: docker postgres + stub `auth`/`storage`).

## PR 2 — storyboard write paths in the API

Store functions + Express routes (own route file under
`apps/api/src/routes/v1/`, registered in the smallest protected-routes file —
no catch-all index):

- CRUD for storyboards/scenes/beats/panels; every row carries `project_id`
  (composite FK chains enforce same-project integrity for free).
- **The snapshot contract is non-negotiable** (trigger-enforced): once a beat
  has `beat_asset_id`, semantic edits (`intent`, `visual_description`,
  `dialogue_summary`, `narration`, `duration_sec`) must mint a new
  beat-snapshot asset (kind `beat`, same `lineage_id`, marker-stamped
  `content`) and move `beat_asset_id` in the same write.
- Panel selection writes `storyboard_panels.is_selected` only — never the
  `selections` table (one source of truth; see asset-graph-schema.md §3.5).
- Reorder = swap `scene_index`/`beat_index`/`panel_index` within the parent
  (unique per parent).

## PR 4 — provenance wiring: inputs, edges, fingerprints

The graph can't compute blast radius until writers record what things were
built from:

- Generation writers populate `assets.inputs`
  (`[{assetId, relation, role?, position?, contentHash}]`) — the sync trigger
  materializes `asset_edges`. Beat snapshots list the brief; keyframes list
  their beat snapshot + anchors; clips list keyframe + beat + anchors; panels'
  image assets list their prompt asset.
- Define the canonical hash (sha256 over canonically-serialized semantic
  content) in `packages/shared`; writers set `content_hash` (data kinds at
  insert; media kinds when bytes land) and `inputs_fingerprint` (hash over
  sorted input contentHashes + params hash).
- Acceptance: after generating from a storyboard, `downstream_assets(beatSnapshotId)`
  returns that beat's keyframe/clip chain and nothing else.

## PR 5 — actions decision log + proposals

Generation and edit paths record `actions` rows (tool, `input_asset_ids`,
rationale, `output_asset_ids`, cost), and expensive operations write a
`proposal` with pinned fingerprints before spending (North Star Principle 5).
Honor `generation_runs.budget_usd`/`gates`. This is the audit trail the
orchestrator (P2) reasons over; without it, "why did the agent do that" is
unanswerable.

## PR 6 — staleness + manifest surface

Expose the graph to agents and the UI: an endpoint wrapping
`project_manifest()` (the orchestrator's working context) and a
"stale candidates" endpoint that, given a changed asset, returns
`downstream_assets()` joined with current selections and recorded
fingerprints. Stale is a *signal* the agent may prune, never an auto-cascade
(North Star §8). This PR is the on-ramp to the P2 orchestrator.

## PR 7 — lift the `generation_runs.gates` JSONB exclusion

20260610130000 deliberately left `gates` unconstrained "until the temporary v1
bridge is removed." When the v1 compatibility bridge dies, add the typed check
(schema marker or a flat string array) in a new migration.

## Ordering & dependencies

```
P0 (deploy check)
PR 1 (backfill/validate)          — independent, do early
PR 2 (storyboard API)
PR 4 (provenance/fingerprints) ──▶ PR 6 (staleness surface) ──▶ P2 orchestrator
PR 5 (actions log)             ──▶ PR 6
PR 7 — whenever the v1 bridge is removed
```

PRs 1, 2, 4, 5 are mutually independent and can run in parallel.
