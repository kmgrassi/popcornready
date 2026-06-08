# North Star — Agent-Orchestrated, Non-Linear Video Generation

> **Status:** Vision + scope. **Not implemented yet.** This is the authoritative
> reference for how generation should evolve. New work (human or agent) should
> align to it, and any deviation should be a conscious, documented decision.
> Last updated 2026-06-08.

## 0. What Popcorn Ready is (the positioning)

**Popcorn Ready is the agent harness for video.** Coding harnesses — Codex,
Claude Code, and the like — turned software into something you *direct* instead
of hand-build: you state intent, and an agent plans, writes, and edits the code.
Popcorn Ready is that harness for video. You describe what you want; the agent
plans the beats, generates the assets, edits the cut, and renders. This is the
AI-first way video gets made.

This is not a tagline bolted on after the fact — it *is* the architecture below.
A harness is only a harness because **the agent owns the whole flow and every
stage is a tool it calls** (§2, Principle 1). Everything in this document — the
non-one-directional pipeline, stages-as-tools, selective regeneration, the
provenance graph the agent reasons over — is what makes the harness framing
true. Conversely, the model we must NOT entrench (§3, the forward-only "edit the
timeline with patches" conveyor belt) is the *opposite* of a harness: it's a
fixed pipeline with AI bolted on. Keep new work on the harness side of that line.

This positioning is the product's public value proposition (the landing page and
[`scopes/website-and-productization.md`](scopes/website-and-productization.md)
lead with it); align marketing and product copy to it.

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
3. **Non-one-directional / selective regeneration — the agent decides, not a
   rigid cascade.** Changing one input should affect only the impacted
   sub-video(s), never all of them. The dependency graph + fingerprints (§5)
   cheaply compute a **candidate** "possibly affected" set; that set, **plus the
   stable IDs and provenance, is passed to the agent, which makes the final
   call** — and may prune the cascade when it judges a change semantically
   irrelevant (e.g. a prompt edit that has nothing to do with a given image).
   Determinism scopes the *possibilities*; the agent decides the *actuals*.
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
7. **Determinism lives in the tool contracts, not in a fixed order — and the
   agent self-heals.** Each tool (API call) **deterministically validates its
   inputs** ("a video with a main character requires a character likeness";
   "because you have X you also need Y") and, on a miss, returns a **structured,
   actionable failure** instead of doing the wrong thing. The failure bounces
   back to the agent, which **satisfies the precondition (e.g. generates the
   missing anchor image) and retries.** Step ordering is therefore *emergent*
   from the contracts — the agent reacts to what each step says it needs rather
   than following a hardcoded sequence. This is what makes the flow both flexible
   (agent-driven) and reliable (every step guards its own preconditions), and it
   is how the "deterministic first pass" is achieved without prescribing order.
8. **Compose recursively; generate in parallel; stitch.** An asset is either
   *atomic* (a generated clip/image/audio) or *composite* (an ordered selection
   of other assets, referenced by ID). Composition is **recursive and uniform** —
   clip → scene → sub-video → movie are the *same* "composite asset" concept at
   different levels. So long videos are **decomposed, not brute-forced**: a
   90-minute movie is nine 10-minute sub-videos (each scenes, each clips),
   generated **in parallel** and stitched. A repeated scene is **one composite
   referenced many times** (reuse, not regeneration). Today's timeline is just
   one composite kind; we generalize so composites can contain composites, and
   the composition tree and the dependency graph become the same graph. **The
   agent owns this decomposition** — deciding *when and how* to split a long
   piece into parallel sub-videos is a higher-order strategy call the agent makes
   itself, not a user instruction or a deterministic rule. (We needn't build
   feature-length tooling now; the model just assumes the agent drives it.)
9. **Nothing is throwaway — everything is persisted.** Every asset, including
   intermediate anchors/keyframes and every composite, is persisted in the pool
   (never a temp file). Beyond reuse, persistence is the **audit trail** for *why
   the agent did what it did*.

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
- **Atomic vs composite assets (recursive).** An asset is either *atomic*
  (generated media) or *composite* (an ordered list of child asset IDs it
  stitches). The same shape models a clip, a scene, a sub-video, and a whole
  movie; composites can contain composites. Independent composites generate **in
  parallel**; a reused scene is one composite referenced many times. The
  composition tree and the provenance/dependency graph are the same graph.
- **Invalidation via input fingerprints — a *signal to the agent*, not a hard
  rule.** Each asset stores a content hash of its semantic inputs (including
  upstream asset hashes), so a change yields a cheap, deterministic **candidate
  stale set**. The **IDs + provenance + candidate set are passed to the agent**,
  which makes the final regeneration decision and may prune cascades it judges
  irrelevant. (Stable IDs on every node are the prerequisite — the agent reasons
  over IDs.)
- **A regeneration vocabulary** beyond timeline patches: `regenerate_asset`,
  `change_beat`, `swap_anchor`, `rescore_audio`, … — the agent's tools.
- **Assets live in a reusable pool; locations point at an "active" one.**
  Generated assets (anchors, keyframes, clips, audio) are **immutable items in a
  shared pool — never deleted.** Each **location/slot** (a beat, an anchor role,
  a timeline segment) carries an **active selection** referencing the pooled
  asset it currently uses. Regeneration **adds** a new asset to the pool and may
  flip the slot's active pointer; the previous asset stays available and **can be
  reused in a different location** (an asset that's wrong for slot A may be right
  for slot B). "Not in use" ≠ "unusable." This generalizes today's `Clip[]` pool
  + `TimelineSegment.clipId` reference to every asset kind, and is exactly what a
  future dashboard browses ("I like image 10 — use it here" = re-point a slot's
  active selection, no regeneration).
- **One project-scoped asset pool — not multiple stores.** A **project** (one
  video creative effort, under a workspace) is the only container: **every asset
  carries a `projectId`** and lives in a single flat pool, never deleted.
  Relationships are carried **on the assets themselves** (provenance + input IDs
  + role / what-it-depicts) and by the plan/timeline's **active selections** (IDs
  pointing into the pool) — not by separate versioned-store collections. The
  agent pulls the project's pool and reasons over it **by ID**; tools receive the
  specific asset IDs (and prompts) they need. Versioning falls out for free:
  assets are immutable in the pool, selections move. **Prerequisite: assets must
  be self-describing** — kind, provenance (what it was generated from, by ID),
  and what it depicts/role — or the agent can't decide which asset feeds which
  call. (Today `Clip.generatedBy`/`characterBinding` do half of this; we make it
  consistent across every asset kind and add `projectId`.)
- **An orchestrator agent** that holds the creative state, calls the tools, runs
  a sensible default order on the first pass, and computes + **proposes** the
  minimal re-run on any change.

## 6. Tool surface (capabilities the orchestrator calls)

`plan/replan` · `generate/regenerate anchor` · `generate/regenerate beat keyframe`
· `generate/regenerate beat clip` · `generate/regenerate audio` ·
`assemble/re-assemble timeline` · `critique` · `export`. Each is **granular,
idempotent, and records its inputs** so the graph stays accurate. Each tool also
**validates its pre/postconditions and returns typed, actionable errors**
(missing inputs, implied requirements) so the orchestrator can **self-heal and
retry** (Principle 7). The dependency graph (§5) is largely *expressed* by these
contracts: a tool declaring "I need a character likeness" is the edge from a clip
to its anchor.

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

## 8. Design decisions (all resolved 2026-06-01)

These were the open P0 questions; all are now decided and are **constraints for
P1**. Kept here with their resolutions as the design record.

- ~~**Invalidation granularity**~~ **— DECIDED:** per-asset content fingerprints
  (with nested upstream hashes) produce a *candidate* stale set; the agent
  receives the IDs/provenance/candidates and makes the final call. Stale is a
  signal, not a command (Principle 3, §5).
- ~~**First pass vs edits**~~ **— DECIDED (Principle 7):** no hardcoded order;
  determinism lives in each tool's input validation, and the agent self-heals by
  reacting to structured failures.
- ~~**Re-run downstream policy**~~ **— DECIDED:** an asset **pool** model —
  assets are immutable and never deleted; each location has an **active**
  selection; regeneration adds to the pool and may flip the active pointer;
  idle assets stay reusable across locations. The agent proposes which slots to
  refresh (Principle 5); old outputs are superseded, not destroyed.
- ~~**Trunk for creative state**~~ **— DECIDED:** collapse to **one
  project-scoped asset pool** (no dual store). A project (under a workspace) is
  the container; every asset carries `projectId`; relationships live on the
  assets (self-describing: provenance/input-IDs/role) plus the plan/timeline's
  active selections. Drop the heavy versioned-store machinery; immutable assets +
  moving selections give versioning for free.
- **Pool scope — default for now:** project-scoped; recursive composition
  (Principle 8) handles long-video scale *within* a project. Cross-video reuse
  (promote a recurring character/logo up to the **workspace**) is deferred.
- ~~**Cost guardrails**~~ **— DECIDED (keep it simple first):** cheap ops
  (planning, images/anchors/keyframes) just run; expensive/fan-out ops (video,
  big regenerations) **propose an estimate first**, and autonomous runs honor a
  **budget ceiling** (pause + ask when hit). The first-pass estimate is
  deliberately **crude** — a rough rate (~$0.50/sec) plus a few high-level
  heuristics (e.g. audio) — refine later. Most relevant once videos exceed ~1
  minute.
- ~~**Retire the single-hero character path**~~ **— DECIDED:** fold character
  into the anchor model (a character is an anchor with identity invariants);
  retire the single-hero `generateCharacterHeroFrame` / single-`CharacterProfile`
  path.

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
