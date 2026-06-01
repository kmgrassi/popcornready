# North Star — Agent-Orchestrated, Non-Linear Video Generation

> **Status:** Vision + scope. **Not implemented yet.** This is the authoritative
> reference for how generation should evolve. New work (human or agent) should
> align to it, and any deviation should be a conscious, documented decision.
> Last updated 2026-06-01.

## 1. The North Star (read this first)

We want **one continuous generation pipeline that runs end-to-end on its own**,
where a **central agent owns every step as a callable tool** and can **drop into
or re-trigger any part of the flow**.

The agent sets the high-level goal, produces the **schema** (the plan: beats +
reference anchors), and moves through asset generation with **feedback loops at
each stage**. As assets pop out — the plan, the anchor images, the per-beat
keyframes, the clips, the cut — the user can look at them, stop, and say "redo
this."

Crucially, the flow is **not one-directional**. When something changes — "rethink
the audio" — the agent decides the **minimal set of work to redo**. That might be
audio-only, or it might ripple *back* and re-do a couple of shots. We must not
trap ourselves in the old, forward-only "edit the timeline with patches" model.

## 2. Principles (the mental-model shift)

1. **The agent owns the flow; stages are tools.** `brief → plan → anchors →
   keyframes → clips → audio → assemble → critique → export` are **tools the
   agent calls**, not a fixed conveyor belt. Give the agent latitude; don't be
   prescriptive about order.
2. **Autonomous by default; stops are opt-in.** With no gates, it runs straight
   through (today's one-shot behavior, just observable). The user — or an
   optional gate — can pause at any artifact.
3. **Non-one-directional / selective regeneration.** Changing one input
   recomputes only the affected assets. Editing one part of the story arc should
   affect only the impacted sub-video(s), never all of them.
4. **A dependency/provenance graph is the foundation — not the agent's
   cleverness.** Minimal re-runs are only possible if the data records *what each
   asset was built from* (which beat, which anchors, which audio, which prompt /
   model / seed). Build the graph; the agent reasons over it. This is no-regret:
   you need it whether a human, a rule, or the agent decides the re-run.
5. **Propose before expensive redo.** The agent proposes a re-run plan ("to fix
   the audio I'll re-score only — no image changes" / "this needs beats 2 & 5
   re-shot, ~$X — go?") before spending. This *replaces* rigid gates with natural
   human-in-the-loop.
6. **One engine.** The synchronous one-shot route and the async run pipeline
   **converge into a single engine**. The staged "run" model is the trunk; the
   quick call becomes a thin entry into it.

## 3. Where we are today (the model we must NOT entrench)

(See the data-model map in §4 for citations.) Today:

- Generation is **forward-only and all-or-nothing.** Plan → timeline flows via
  append-only patches; any upstream change triggers a **full re-run**.
- The agent surface (`planEdit`, `critiquePlan`, `critique`, `revise`, …) only
  edits a **single timeline forward** via `Patch`es keyed by `segmentId`. There
  is **no patch op that regenerates an asset, changes a beat, or swaps a
  reference**, and **no orchestrator** that exposes these as tools.
- There are **two drifted pipelines** (`/api/oneshot` + `src/lib/runs/execute.ts`
  vs the `/api/v1` job stack) and **two `GenerationRun` definitions**.
- There are **no dependency edges**: beats have **no stable id** (linked to
  segments only by a `role` string), and generated assets store the prompt but
  **not the beat/anchor** they serve. So "beat 3 changed → regenerate clip 3"
  **cannot be computed from data today.**

## 4. The current data model — seams to build on (grounded)

The good news: provenance is already reasonably rich. The gap is **dependency
edges + invalidation + an orchestrator**.

**What already exists (reuse these seams):**

- **Per-asset provenance.** `Clip.generatedBy { provider, model, prompt,
  providerPrompt, characterBinding, preflight, costUsd }` and
  `GeneratedAssetCharacterBinding { referenceIds, consistencyMode, seed,
  promptInvariantVersion, consistencyReview, videoReview }` (`src/lib/types.ts`).
  Records *what an asset was made from* — but only character references, plus the
  free-text prompt.
- **Timeline-level lineage.** `VersionedTimeline.provenance { briefVersionId,
  compositionId, sourceAssetIds, generatedAssetJobIds, criticReport,
  derivedFrom.editGraphId }` (`src/lib/v1/types.ts`) — the strongest lineage
  record in the codebase.
- **A per-asset, idempotent job abstraction (v1 only).** `asset_generation` jobs
  (`src/lib/api/v1/`, `/api/v1/projects/**/generated-assets`) are individually
  addressable with `Idempotency-Key` and carry `GeneratedAssetProvenance`
  (`referenceAssetIds`, etc.). A single asset *can* already be regenerated and
  re-attached.
- **Versioned, sibling-able timelines** keyed by id in `V1Store`, with
  `editGraphId` + compiler version.
- **An operation log with alternatives.** `EditGraph.edit.revisionOperations`
  (`src/lib/edit-graph.ts`) keeps `patch + rationale + alternatives` per edit.
- **A typed (but unused) dependency vocabulary.** `OverlayAnchor { type:
  beat|object|person|spoken_phrase|timeline_time, refId, offsetMs }` in
  `src/lib/edit-graph/types.ts` — the only place a reference-by-id dependency is
  modeled. Aspirational, not wired.
- **Review signals that name the corrective action.** `VideoSnapshotReview
  .recommendedAction: keep|regenerate|manual_review`, plus `PlanCritiqueReport`
  and the pre/post critique loops (PR #90).
- **Anchors** (planner-decided reference subjects + per-beat usage) from the
  keyframe work (PR #89) — the consistency mechanism this whole model leans on.

**What's missing / one-directional (the work):**

1. **No dependency edges.** Beats need **stable ids**; assets must record the
   `beatId` / `anchorIds` / `audioId` they were generated for (today only the
   prompt + character `referenceIds` are stored). Without this, minimal re-run is
   impossible.
2. **No invalidation / staleness.** No `inputHash`, `stale`, or version pinning
   on derived assets; no way to detect that an input drifted.
3. **Generation is not a graph node.** The edit graph models only
   `select_segment` decisions; *generating* an asset is a side effect outside the
   graph, so the graph can't express "regenerate this node."
4. **Patches are timeline-forward only** (no `regenerate_asset` / `change_beat` /
   `swap_anchor`).
5. **No central orchestrator** exposing the agent functions as tools; both
   runtime pipelines are hardcoded linear stages.
6. **Two drifted run/pipeline models** and **one mutable `Project` / one
   `timeline` / one `editGraph`** (id `"default"`, no revision array).

## 5. Target data model (direction, not a final schema)

- **Stable ids on every node.** Beats get ids; anchors already have ids (PR #89);
  audio, keyframes, and clips are addressable. Derived assets reference the ids
  of their inputs.
- **A dependency/provenance graph.** Each generated asset records its inputs
  (`beatId`, `anchorIds[]`, `audioId?`, prompt/model/seed fingerprint). The graph
  makes blast radius **computable**: change beat 3 → its keyframe + clip (and
  maybe audio + the cut) are stale; nothing else.
- **Generation as a first-class node**, not a side effect — so the graph can say
  "this node is stale, regenerate it" and the timeline remains a pure projection.
- **Invalidation via input fingerprints** (hash the inputs that produced an
  asset; recompute only what changed).
- **A regeneration vocabulary** beyond timeline patches: `regenerate_asset`,
  `change_beat`, `swap_anchor`, `rescore_audio`, … — the agent's tools.
- **One creative-state aggregate with versioning**, leaning on the existing
  `VersionedTimeline.provenance` + per-asset `asset_generation` jobs rather than
  the single mutable `Project`.
- **An orchestrator agent** that holds the creative state, calls the tools, runs
  a sensible default order on the first pass, and computes + **proposes** the
  minimal re-run on any change.

## 6. Tool surface (capabilities the orchestrator calls)

`plan/replan` · `generate/regenerate anchor` · `generate/regenerate beat keyframe`
· `generate/regenerate beat clip` · `generate/regenerate audio` ·
`assemble/re-assemble timeline` · `critique` · `export`. Each is **granular,
idempotent, and records its inputs** so the graph stays accurate.

## 7. Scope & phasing (each independently shippable — do NOT implement ahead of agreement)

- **P0 — Design (this doc).** North Star + data-model direction agreed.
- **P1 — Foundation (no behavior change):** stable beat/anchor ids + the
  dependency/provenance graph + granular idempotent generation tools, and
  **unify the two pipelines** into one engine (kills the drift, e.g. the 1:1
  size mismatch). Everything becomes observable and re-runnable.
- **P2 — Orchestrator agent:** the agent calls the tools; on change it computes
  the **minimal** re-run and proposes a plan (with rough cost) before spending.
- **P3 — Inspection, gates & feedback loop:** artifacts visible as they pop;
  approve/regenerate any stage; approvals/edits feed back to improve prompts
  (ties into `docs/scopes/ooda-feedback-loop.md`). First pass stays a reliable
  default ordering; agent latitude shines in the edit/re-run loop.

## 8. Open questions to resolve before P1 implementation

- **Invalidation granularity** — per-beat vs per-asset; the input-hash strategy.
- **First pass vs edits** — keep the initial build a deterministic default order;
  reserve agent improvisation for re-runs?
- **Re-run downstream policy** — auto-invalidate everything downstream of a
  changed node, or keep old outputs until the user/agent confirms?
- **Trunk for creative state** — extend `Project`, or make the `/api/v1`
  versioned stack the home? (Pick one; retire the other.)
- **Cost guardrails / propose-before-spend UX.**
- **Retire the single-hero character path** in favor of anchors (started in #89).

## 9. Provenance & related reading

- **Agent memory:** `generation-pipeline-architecture` (mirrors this doc).
- **PRs:** #89 (per-beat keyframes + planner-decided anchors), #90 (pre/post
  generation critique loops).
- **Related scopes:** `docs/scopes/ooda-feedback-loop.md`,
  `docs/scopes/ai-native-edit-graph.md`, `docs/scopes/project-model-storage.md`,
  `docs/scopes/jobs-processing.md`,
  `docs/scopes/generation-review-checkpoints.md`,
  `docs/scopes/character-consistency-generation.md`,
  `docs/scopes/video-snapshot-review.md`.
- **Research:** `docs/research/character-consistency-video.md`.
