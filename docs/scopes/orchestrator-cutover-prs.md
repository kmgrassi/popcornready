# Orchestrator cutover — V1 keep/replace/delete + PR roadmap

Tracks the work to move Popcorn Ready's live generation **off the V1 staged
engine and onto the orchestrator tool-calling loop** — an agent that calls one
server-owned tool per turn, runs autonomously to a finished video by default, and
recomputes only affected assets via the asset graph. Scoped into PRs that
parallelize; each lists its dependencies.

> **This is a proposed breakdown — edit freely.** Status reflects the state at
> this doc's creation. There are **no production users**, so there is **no
> backwards-compatibility constraint**: we migrate forward and delete the old
> controller outright (per [`CLAUDE.md`](../../CLAUDE.md) "No legacy/compat code").

## Design is owned elsewhere — this doc is the execution plan

This roadmap **consumes** the existing design docs rather than restating them:

- [`structured-outputs-to-tool-calls.md`](structured-outputs-to-tool-calls.md) —
  the target contract: server-owned tools, the orchestrator decides order, the
  server keeps validation/persistence/jobs/auth.
- [`north-star-orchestrator-tools.md`](north-star-orchestrator-tools.md) — the
  tool-contract layer + self-healing loop + precondition vocabulary.
- [`north-star-unified-engine.md`](north-star-unified-engine.md) — the staged
  engine the orchestrator replaces/hosts.
- [`generation-engine-media-stages-prs.md`](generation-engine-media-stages-prs.md)
  — resolve-or-generate + per-beat durability; the media primitives to reuse.
- [`../NORTH_STAR.md`](../NORTH_STAR.md) — the authoritative vision.

What's **new here**: the concrete keep/replace/delete decision on the existing V1
code, the PR ordering with the test harness as the gate, and the autonomy/gate
default.

## The decision: V1 is two layers with opposite fates

"Keep V1 or delete V1?" is the wrong question — V1 is **two layers**:

- **The capability/framework layer → KEEP.** The asset-graph store
  (`lib/api/v1/store.ts`: assets, projects, workspaces, actions, selections,
  storyboards), the asset/project/brief/timeline/plan **API routes**, the agent
  LLM functions (`packages/agent`: `planEdit`, `critique`, `selectClips`), the
  media-generation primitives (`lib/generative/*`: keyframe, clip, audio,
  storyboard-tile, providers), and the job system (`lib/agent-api`,
  `lib/v1/store.ts` job/timeline persistence). **The orchestrator tools call
  directly into this** — the wired `create_or_load_brief` tool already does
  (`store.addProjectBrief`).
- **The forward-only staged *controller* → DELETE.** `runGenerationJob`
  (`lib/v1/generation.ts`), `run-execution.ts`, the 9-stage ordering + seed
  stages, `story-flow-tools.ts`, and the per-stage review-gate machinery. This is
  the model [`NORTH_STAR.md`](../NORTH_STAR.md) explicitly says **not to
  entrench**, and it's only a partial driver anyway — it runs
  `plan → storyboard → timeline → critique` and **never executes
  keyframe/clip/audio/export** (see generation-engine-media-stages-prs.md).
- **The run lifecycle → REPLACE.** `lib/v1/generation-runs/*` (stage-oriented
  run/stage/artifact persistence + progress + status) is superseded by an
  orchestrator-native run model (runs / turns / tool-invocations), ideally folded
  onto the asset-graph `actions` table per North Star.

### Boundary table (the part that must be detangled)

| V1 surface | Bucket | Note |
| --- | --- | --- |
| `lib/api/v1/**` (store, assets, projects, brief, schemas, auth, jobs, provenance) | **KEEP** | The durable framework; tools read/write here. |
| `lib/generative/**`, `lib/agent-api/**`, `packages/agent/**` | **KEEP** | Media/job/agent primitives tool handlers call. |
| `lib/v1/store.ts`, `supabase-client.ts`, `actor.ts`, `logger.ts`, `redact.ts`, `errors.ts`, `http.ts` | **KEEP** | Job/timeline persistence + shared utils. |
| `lib/v1/generation/{create-job,prepare,storyboard}.ts` | **KEEP** | Job record + `briefToStoryContext`/`assetToClip` + tile fan-out. |
| `lib/v1/generation-runs/**`, `generation-progress.ts`, `eval/inline-hook.ts` | **REPLACE** | Stage-run lifecycle → orchestrator run model. |
| `routes/v1/generation-runs.ts` | **REPLACE** | Stage-run + gate API → orchestrator-run API. |
| `lib/v1/generation.ts`, `generation/run-execution.ts`, `generation/story-flow-tools.ts`, `generation-runs/recovery.ts` | **DELETE** | The forward-only controller. |
| `routes/v1/generations.ts`, `routes/v1/generation-entrypoints.ts` | **DELETE** | Staged-engine entry/runner routes. |
| `lib/generation-run/fixtures.ts`, `lib/oneshot/*` | **DELETE** | Staged-run fixtures / orphaned (verify before delete). |

### Cross-boundary couplings to sever first

KEEP code currently reaches into REPLACE/DELETE code — these block deletion:

1. `briefToStoryContext` + `assetToClip` live in `lib/v1/generation/prepare.ts`
   (adjacent to the controller) but are pure transforms imported by KEEP code
   (`lib/api/v1/plan.ts`, `routes/v1/timelines.ts`, `lib/v1/assemble.ts`).
   → **Extract to a shared util** (`packages/shared` or `lib/story-context`).
2. `lib/api/v1/store.ts` (KEEP) imports `lib/v1/generation-runs/store` and queries
   the `generation_runs` table directly (`assertRunBudgetAllows`, workspace run
   summaries). → **Repoint at the orchestrator run model** once it exists.

## Gating model (confirmed)

**Autonomous by default.** A run with no gates goes prompt → finished video with
**no user round-trips**. The UI prompts the user up front — "which steps do you
want it to stop at?" — and if they select none, the run is fully autonomous.

- Gates are an **opt-in, per-run** set chosen before the run starts.
- Mechanism already modeled in the driver: a tool returns `waiting_for_approval`
  (→ run parks on an approval gate) only when a gate is requested; otherwise the
  loop keeps selecting the next tool. Async media tools return `accepted` + a
  jobId and the loop parks on the job, resuming when it terminates.
- "Checks at each step" = **tool preconditions** (the declared but unused
  `PreconditionMiss` / `unmetRequirements` / `suggestedNextTools` contract): each
  tool fails fast with an actionable miss if its inputs aren't in the asset graph,
  and the loop self-heals by calling the suggested tool. State passes stage→stage
  **through the asset graph** (assets/edges/selections), not through raw in-prompt
  outputs — `priorResults` is only the model's short-term memory.

## PR roadmap (ordered; harness gates every step)

> **PR 1 is merged.** Each generation-tool PR (PR 3.x) is independently
> reviewable and verified by its harness battery before the live flip (PR 4).

- **PR 1 — Tool-call test harness ✅ (merged, [#317](https://github.com/kmgrassi/PopcornReady/pull/317)).**
  The end-to-end rig: dev endpoint + CLI, throwaway sandbox + teardown, one
  battery per tool. Verifies "model calls the right tool with schema-valid input
  and the real DB write succeeds" as each tool is wired.

- **PR 2 — Autonomous orchestrator engine (backbone).** Depends on PR 1.
  - Persist runs / turns / tool-invocations (new tables, or projected onto the
    asset-graph `actions` table — coordinate with store-consolidation).
  - The **multi-turn driver loop**: re-invoke the model until `done` /
    `export_video` completes; park on `accepted` jobs and `waiting_for_approval`
    gates and resume; thread accumulated `priorResults`; enforce the per-run gate
    set (default: none → fully autonomous) + a crude cost guardrail.
  - This is where the end-to-end one-shot lives. No new generation capability yet
    — drives the existing `plan_shots` + `create_or_load_brief` tools to prove the
    loop runs autonomously start→finish.

- **PR 2.5 — Detangle the keep/delete boundary.** Can run concurrent with PR 2.
  Extract `briefToStoryContext`/`assetToClip` to a shared util; repoint
  `lib/api/v1/store.ts` off `generation_runs` onto the PR 2 run model. Unblocks
  deletion in PR 5.

- **PR 3.x — Wire the generation tools (parallelizable, one per tool).**
  Depends on PR 2. Each backs an orchestrator tool with the **existing**
  `lib/generative/*` primitives + `packages/agent` functions, implements its
  preconditions, writes assets+edges+selections (resolve-or-generate, per-beat
  durability — see generation-engine-media-stages-prs.md), and **replaces its
  `pending` harness battery with real cases**:
  `plan_shots` (persist the plan asset) · `plan_visual_anchors` · `generate_anchor`
  · `generate_storyboard` · `generate_keyframe` · `generate_clip` ·
  `generate_audio` · `assemble_timeline` · `critique_timeline` · `request_approval`
  · `export_video` · `develop_story_blueprint` · `draft_script`.

- **PR 4 — Flip the live route.** Depends on PR 2 + enough of PR 3.x for a full
  video. Point the generation entrypoint (and the UI's "generate" action) at the
  orchestrator engine behind `POPCORN_ORCHESTRATOR_TOOL_LOOP`; run a real prompt
  end-to-end autonomously; wire the gate-selection UI.

- **PR 5 — Delete the staged controller.** Depends on PR 2.5 + PR 4 parity.
  Remove the DELETE-bucket files + the REPLACE-bucket staged run lifecycle once
  nothing imports them. Drop `generation_runs`/stage tables via an additive
  drop+create migration (no history rewrite — see
  [`../no-migration-history-rewrites`](../../CLAUDE.md)).

## Definition of done

- A prompt with no gates produces a finished video through the orchestrator loop
  with zero user round-trips; a prompt with gates pauses only at the selected
  steps.
- Every wired tool has a green harness battery, including a schema-rejection
  invariant case.
- The `lib/v1` staged controller + `routes/v1/generations*.ts` are gone; nothing
  imports `lib/v1/generation-runs`; `lib/api/v1/store.ts` no longer reads
  `generation_runs`.
