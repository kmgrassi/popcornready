# Granular generation API — every stage as its own endpoint

> **Status:** Scope / design. **Not implemented.** Proposes a coherent, granular
> HTTP surface so callers (the web app, the agent, the eval framework, external
> tools) can tie into **any single aspect of generation independently** — the
> story alone, one image, one clip, an assemble, a critique — rather than only
> the all-or-nothing one-shot. Last updated 2026-06-05.
>
> Aligns with `docs/NORTH_STAR.md` §6 ("stages are tools the agent calls"),
> `docs/scopes/north-star-orchestrator-tools.md`, and the bounded-execution
> capability in `docs/scopes/stage-eval-framework.md`.

## 1. Objective

Today, generating video is essentially **one call that does everything**
(`POST …/generation-entrypoints/prompt` → brief → plan → assets → timeline). You
cannot ask the API for *just the story*, or *just one regenerated clip*, over a
clean endpoint. We want **a dedicated endpoint per generation capability**, so a
caller can "tie in at different locations":

- "Give me a storyboard/plan for this prompt — no assets." → one call.
- "Generate this one image / this one clip." → one call.
- "Re-stitch the timeline." / "Critique this cut." / "Export." → one call each.

Each endpoint is a **tool**: granular, idempotent, records its provenance, and is
**re-entrant** (call it standalone, in any order, as many times as you like).

## 2. Where we are today (grounded)

The current `/api/v1` surface is richer than it looks, but the **creative stages
are locked inside the pipeline** and two execution models have drifted.

**Already granular (reuse / generalize):**
- `POST …/generated-assets` `{ kind: image | video | audio, provider, prompt, … }`
  — the low-level per-asset generator (idempotent job + poll). Providers:
  `openai` (image/video), `gemini`/`runway`/`ltx`/`nvidia_api_catalog` (video),
  `elevenlabs` (audio). **This is the "generate an asset" primitive — keep it.**
- `…/characters`, `…/characters/:id/references` — character/anchor management.
- `…/brief`, `…/brief-versions` — the brief.
- `…/compositions` — **stores** a caller-supplied composition (beats); it does
  **not** generate them.
- `…/timelines/:id/revisions`, `…/timelines/:id/exports`, `…/exports`,
  `…/audio-alignments` — timeline revise / export / audio sync.
- `…/generation-runs` (+ `/approve`,`/reject`,`/cancel`,`/retry`) — the staged
  run with `reviewGates`.

**Locked inside the pipeline (no standalone endpoint):**
- **Story/plan.** `planEdit` (prompt → beats) runs **only** inside
  `runGenerationJob`. `…/compositions` stores beats; nothing *generates* them.
  → **There is no "make me a story" endpoint.**
- **Critique.** `critique` / `critiquePlan` run only inside the pipeline.
- **Assemble/select.** `selectClips` (beats + assets → timeline) runs only inside
  the pipeline.

**The drift (must reconcile):**
- The pipeline executes via `…/generations` and `…/generation-entrypoints/*`
  (which call `runGenerationJob`), **but** `…/generation-runs` only *queues* a
  staged run (`createRunWithSeedStages`, `status: queued`) and is not wired to
  the executor. Two models, one engine's worth of behavior split across them.
- The engine **already supports** `stopAfter: <stage>`, `promptsOnly: true`, and
  `reviewGates` (landed in #165, `generation.ts`) — but **`stopAfter`/
  `promptsOnly` are not read from any HTTP request.** The capability exists; the
  door isn't cut.

## 3. The target surface (capability → endpoint)

All under `/api/v1/projects/:projectId/`. Each is a thin entry into the **one
engine** (§4). Dedicated endpoints (per the request), not a single
mega-parameterized call.

| Capability | Endpoint | Notes |
| --- | --- | --- |
| **Plan / story** | `POST …/plan` | prompt **or** `briefVersionId` + length/style/aspect → runs `planEdit`, returns beats (the story). No assets. Optionally persists as a composition. **NEW.** |
| Plan critique | `POST …/plan/critique` | `critiquePlan` on a plan → `PlanCritiqueReport`. **NEW.** |
| Replan | `POST …/plan` (with prior plan + feedback) | re-run planning; new plan in the pool. **NEW.** |
| **Anchor / character image** | `POST …/characters/:id/anchors` | generate/regenerate the reference likeness (today: generic `generated-assets` + character binding). **NEW thin wrapper.** |
| **Beat keyframe (image)** | `POST …/beats/:beatId/keyframe` | per-beat still, **records `beatId`/`anchorIds`** provenance. Today only via generic `generated-assets`. **NEW.** |
| **Beat clip (video)** | `POST …/beats/:beatId/clip` | per-beat video, provenance-recorded. **NEW.** |
| Generic asset (primitive) | `POST …/generated-assets` `{kind}` | image/video/audio low-level generator. **EXISTS — keep.** |
| **Audio (music/narration)** | `POST …/generated-assets {kind:audio}` + `…/audio-alignments` | **EXISTS.** Optional `…/audio` convenience wrapper. |
| **Assemble / stitch** | `POST …/timelines` | `selectClips`/assemble selected assets → timeline. **NEW (selectClips not exposed).** |
| **Critique (timeline)** | `POST …/timelines/:id/critique` | `critique` → scores + patches. **NEW.** |
| Revise | `POST …/generation-entrypoints/revisions` | **EXISTS.** |
| **Export** | `POST …/exports`, `…/timelines/:id/exports` | **EXISTS.** |
| **Full / bounded run** | `POST …/generation-runs` `{ stopAfter?, promptsOnly?, reviewGates? }` | the orchestrated run; granular endpoints are single-stage entries into the same engine. **Expose `stopAfter`/`promptsOnly`; unify with `…/generations`.** |

## 4. Design principles

1. **Each endpoint is a tool** (NORTH_STAR §6): granular, **idempotent**
   (`Idempotency-Key`), and it **records its inputs** — `beatId`, `anchorIds`,
   prompt/model/seed fingerprint — so the provenance/dependency graph stays
   accurate and selective regeneration is possible.
2. **Validate pre/postconditions; return structured, actionable errors**
   (NORTH_STAR principle 7). "Generate a clip for a beat that has a main
   character" → `412`-style typed error "needs a character likeness; generate an
   anchor first," not a wrong result. This lets the agent self-heal.
3. **One engine, not a third model.** A granular call is a **single-stage run**
   on the same engine `runGenerationJob` uses. Reconcile the
   `generation-runs` (queue) vs `generations`/`entrypoints` (execute) drift so
   there is one executor; the dedicated endpoints and the full run share it.
4. **Asset pool + active selection** (NORTH_STAR §5): every generate **adds an
   immutable asset to the project pool**; regeneration adds a new one and may
   flip a slot's active selection. Granular endpoints return the pooled asset id.
5. **Sync vs async by cost.** Cheap stages (plan, critique, assemble) can return
   synchronously; expensive media (image/video/audio) follow the existing
   `generated-assets` job-and-poll pattern.
6. **Re-entrant & order-free.** Any endpoint callable standalone, repeatedly, in
   any order — the contracts (principle 2) enforce what each needs.

## 5. Phasing (each independently shippable)

- **P1 — Story + bounded controls (cheap, unblocks the immediate ask).**
  `POST …/plan` (+ `…/plan/critique`), and **expose `stopAfter` / `promptsOnly`**
  on the run entrypoint. Lets a caller get *just the story* from a prompt today.
- **P2 — Beat-scoped media tools.** `…/beats/:beatId/{keyframe,clip}`,
  `…/characters/:id/anchors`, with **provenance** (`beatId`/`anchorIds`) recorded
  into the asset pool — the foundation for selective regeneration.
- **P3 — Assemble + critique standalone, and unify the engine.** `POST …/timelines`
  (assemble), `…/timelines/:id/critique`, and resolve the
  `generation-runs`-vs-`generations` drift into one executor that all endpoints
  enter.

## 6. Open decisions

1. **Dedicated endpoints vs one parameterized run.** The request is for dedicated
   per-capability endpoints (this doc's default). The alternative — a single
   `…/generation-runs` with `stopAfter`/a stage list — is leaner but less
   discoverable. **Lean: thin dedicated endpoints over the one engine** (best of
   both — clean URLs, shared executor).
2. **Sync vs async granularity.** Confirm which stages return inline vs as a
   job+poll. (Lean: media async; plan/critique/assemble sync.)
3. **Self-heal vs strict preconditions.** When a granular call's prerequisite is
   missing (e.g. clip needs an anchor), does the endpoint **auto-generate** it or
   **return a typed error** for the caller/agent to satisfy? (Lean: typed error
   by default; an `autocreate=true` opt-in.)
4. **Plan persistence.** Does `POST …/plan` always persist a `composition`, or can
   it be a pure/throwaway compute? (Lean: persist to the pool — NORTH_STAR
   "nothing is throwaway"; add a `persist=false` escape hatch.)
5. **Relationship to the eval framework.** These endpoints are exactly what the
   eval workbench's `prompts_only`/step-through needs
   (`docs/scopes/stage-eval-framework.md` §6C) — build once, share.

## 7. Related reading

- `docs/NORTH_STAR.md` — §6 tool surface; the one-engine + asset-pool model.
- `docs/scopes/north-star-orchestrator-tools.md` — the orchestrator that *calls*
  these tools.
- `docs/scopes/north-star-unified-engine.md` — collapsing the drifted pipelines.
- `docs/scopes/north-star-provenance-graph.md` — the `beatId`/`anchorIds`
  dependency edges these endpoints must record.
- `docs/scopes/stage-eval-framework.md` — bounded execution (`stopAfter`/
  `promptsOnly`) and the workbench that drives these endpoints.
- `docs/scopes/api-contract-v1.md` — the existing v1 envelope/conventions to
  extend.
