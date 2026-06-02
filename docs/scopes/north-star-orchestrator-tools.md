# North Star Workstream — Orchestrator Tools

> **Goal:** Turn the generation stages into a **tool-contract layer** — each step
> validates its inputs and returns structured, actionable failures — and put a
> **self-healing orchestrator agent loop** in charge of ordering, a regeneration
> vocabulary, and crude cost guardrails.

## Status

**Scoping only. Not implemented.** This document scopes ONE workstream of the
North Star initiative (`docs/NORTH_STAR.md`). It cites current code and proposes
a target design + PR-sized work breakdown. No code in this PR.

This is the **orchestrator-tools** lane: North Star Principle 7 (determinism in
tool contracts + self-heal), Principle 1 (agent owns the flow; stages are
tools), Principle 5 (propose before expensive redo), and §6 (tool surface).

### Sibling workstreams (cross-reference; do not redo)

- **asset-pool** — the project-scoped immutable asset pool + active selections
  (§5). Tools here *write into* the pool and read assets by ID; this lane does
  not define pool storage.
- **provenance-graph** — stable beat/anchor IDs, per-asset input fingerprints,
  the candidate-stale set (Principles 3–4, §5). This lane **consumes** the
  candidate-stale set and passes it to the agent; it does not build the graph.
- **composition** — recursive composite assets + parallel decomposition
  (Principle 8). The orchestrator loop here **drives** parallel decomposition; the
  composite data model is theirs.
- **store-consolidation** — collapse the dual store into one project-scoped pool
  (§8). Tool I/O targets that consolidated surface.
- **unified-engine** — collapse `/api/oneshot` + `runs/execute.ts` into one
  engine (Principle 6, P1). **Their engine becomes the host that calls these
  tools**; the stages they unify are the tools this lane defines the contracts
  for. Tight coupling — see Dependencies.
- **inspection-feedback** — artifacts visible as they pop, approve/regenerate
  gates (P3). The orchestrator loop here emits the per-step events/proposals
  their UI renders, and honors opt-in gates.

## North Star Alignment

| Principle | This lane delivers |
| --- | --- |
| **1. Agent owns the flow; stages are tools** | The orchestrator agent loop; each generation step wrapped as a callable tool with a declared contract. |
| **2. Autonomous by default; stops opt-in** | Loop runs straight through with no gates; opt-in gates pause it (gate *mechanism* shared with inspection-feedback). |
| **5. Propose before expensive redo** | Cost model: cheap ops run; expensive/fan-out ops emit a proposal; autonomous runs honor a budget ceiling. |
| **7. Determinism in tool contracts; agent self-heals** | The tool-contract shape + structured-error / self-heal protocol — the core of this lane. |
| **8. Compose recursively; parallelize** | The loop owns *when/how* to decompose into parallel sub-videos (strategy call), invoking composition's primitives. |
| **§6 Tool surface** | `plan/replan · generate/regenerate anchor · keyframe · clip · audio · assemble · critique · export`, each granular, idempotent, contract-guarded. |

## Current State (cited)

### The agent functions are stateless single-shot LLM calls

`src/lib/agent/index.ts` exports `planEdit` (`index.ts:79`), `critiquePlan`
(`index.ts:114`), `selectClips` (`index.ts:165`), `critique` (`index.ts:238`),
`revise` (`index.ts:279`), `rewriteNarrationScript` (`index.ts:317`); plus
`planCompositionBeats` in `src/lib/agent/composition.ts:39`. Every one is a thin
wrapper over `structuredCall` (`src/lib/anthropic.ts:49`) — one prompt in, one
JSON object out, no validation of preconditions, no structured failure surface,
no retry. `structuredCall` itself takes only `cachedSystem/user/schema/maxTokens`
(`anthropic.ts:16`) and uses `output_config.format` JSON-schema constraint — **no
tool-use / tool loop anywhere** (a repo-wide search for `tool_use`/`tools:` finds
only v1-job comments, e.g. `src/lib/api/v1/generated-assets.ts:480`).

### Edits are timeline-forward only via the `Patch` union

`Patch` (`src/lib/types.ts:270-297`) is exactly six ops keyed by `segmentId`:
`replace_clip`, `set_trim`, `remove_segment`, `reorder`, `add_segment`,
`set_caption`. There is **no `regenerate_asset`, `change_beat`, `swap_anchor`, or
`rescore_audio`.** `critique` (`index.ts:267`) and `revise` (`index.ts:306`) both
emit `Patch[]`, applied by `applyPatches` (used at `route.ts:455`,
`execute.ts:492`). So the agent can only re-cut an existing timeline forward; it
cannot ask for a new asset or change an upstream beat.

### Both pipelines are hardcoded linear stages — no orchestrator

`src/app/api/oneshot/route.ts` `POST` (`route.ts:180`) hardcodes a numbered
sequence: `planEdit` (`:200`) → `critiquePlan` (`:219`) → hero character
(`:233-239`) → keyframe+clip loop (`:286-395`) → assemble (`:419`) → `critique`
(`:444`) → save (`:481`). `src/lib/runs/execute.ts` `executeRun` (`execute.ts:298`)
is the async twin: the same fixed order expressed as named stages
`brief_intake → creative_plan → asset_generation → timeline_assembly →
quality_review → ready` (`runs/types.ts:RUN_STAGES`), each `startStage` /
`completeStage` / `failStage` (`execute.ts:323-531`). **Ordering is in the code,
not chosen by the agent.** The two pipelines have drifted: both re-implement
`resolveVideoProviders`, `videoSizeForAspect`, `clampSeconds`, `beatPrompt`,
`generateBeatClip`, `generateBeatClipWithReview`, `attachVideoReview`,
`isQuotaError` (`execute.ts:50-296` vs `oneshot/media-generation.ts` +
`oneshot/route.ts`).

### What passes as "self-healing" today is hardcoded and shallow

- **Quota fallback:** a `try/catch` around `generateBeatClipWithReview` that, on
  `isQuotaError`, swaps `provider = providers.fallback` and retries once
  (`route.ts:354-394`, `execute.ts:410-432`). One condition, one provider swap.
- **Visual-review regeneration:** `generateBeatClipWithReview` reviews a clip,
  and if `review.recommendedAction === "regenerate"` re-runs once with feedback
  appended to the prompt (`route.ts:113-178`, `execute.ts:223-272`). The
  recommendation vocabulary (`keep|regenerate|manual_review`) exists on
  `VideoSnapshotReview` but is consumed by a hardcoded `if`, not by an agent.
- **Resume:** `route.ts` reuses existing clips/character/soundtrack
  (`resumableClipsForGoal` etc., `route.ts:233/257/274`) — crash recovery, not
  contract-driven precondition healing.

None of these are an agent reacting to a structured failure. They are fixed
branches in the pipeline.

### A precondition gap exists but is implicit

`oneshot/route.ts` *always* tries to create a hero character before clip
generation (`:233-239`) and only conditionally seeds beat keyframes
(`useBeatKeyframes`, `:250-253`). The North Star example "a video with a main
character requires a character likeness → generate the anchor → retry" is
**exactly this dependency, but it is hardcoded as an unconditional step rather
than a precondition a clip tool declares and the agent satisfies.**

### Cost data already exists but is unused for guardrails

`estimateCostUsd` (`src/lib/generative/pricing.ts:62`) computes a per-asset
estimate; video is **$0.50/sec** for openai/gemini (`pricing.ts:27-35`), audio
$0.01/sec, images $0.05 flat. Providers stamp it onto `Clip.generatedBy.costUsd`
(`types.ts:137`; written at `execute.ts:152`, and inside each provider). **But no
code sums it, estimates a run before spending, proposes, or enforces a ceiling.**
The $0.50/sec rate the North Star cost model calls for already lives here — it is
just never aggregated.

## Gap vs North Star

1. **Stages are not tools.** No callable, contract-bearing tool surface — just
   bare functions and two hardcoded pipelines (`route.ts`, `execute.ts`).
2. **No precondition validation / structured failures.** Tools don't declare
   "I need a character likeness" and return a typed, actionable miss; the only
   guards are ad-hoc `try/catch` provider swaps and an `if` on a review enum.
3. **No orchestrator loop.** Order is hardcoded in two places; no agent decides
   ordering, no self-heal-and-retry, no higher-order decomposition.
4. **No regeneration vocabulary.** `Patch` is timeline-forward only — cannot
   express `regenerate_asset` / `change_beat` / `swap_anchor` / `rescore_audio`.
5. **No cost guardrails.** Per-asset estimates exist but are never aggregated,
   proposed, or capped.
6. **Candidate-stale set has no consumer.** Even once provenance-graph computes
   it, nothing today is shaped to receive it and let the agent prune the cascade
   (Principle 3).

## Target Design

### 1. Tool contract shape

Each generation step becomes a **tool**: a typed function with a declared
`requires`/`produces` contract that validates inputs *before* doing expensive
work and returns a discriminated result. Tools are granular, **idempotent**
(re-running with the same inputs returns the same asset, leaning on the
provenance fingerprints from provenance-graph and the v1 `Idempotency-Key`
seam), and **record their inputs into the asset pool** so the dependency graph
stays accurate (§6: "a tool declaring 'I need a character likeness' *is* the edge
from a clip to its anchor").

```ts
type ToolName =
  | "plan" | "replan"
  | "generate_anchor" | "regenerate_anchor"
  | "generate_keyframe" | "regenerate_keyframe"
  | "generate_clip" | "regenerate_clip"
  | "generate_audio" | "rescore_audio"
  | "assemble_timeline" | "reassemble_timeline"
  | "critique" | "export";

interface ToolContract<I, O> {
  name: ToolName;
  // Cheap, deterministic precondition check run BEFORE any provider call.
  // Returns the unmet requirements as structured, actionable misses.
  validate(input: I, ctx: PoolContext): PreconditionMiss[];
  // Rough cost class + estimate, consulted by the cost guardrail before run.
  estimate(input: I, ctx: PoolContext): CostEstimate;
  run(input: I, ctx: PoolContext): Promise<ToolResult<O>>;
}

type ToolResult<O> =
  | { ok: true; output: O; assetIds: string[]; costUsd: number }
  | { ok: false; error: ToolError };
```

`PoolContext` is read-only access to the project-scoped pool (asset-pool /
store-consolidation lanes) plus the provenance graph + candidate-stale set
(provenance-graph lane). `validate` is the home of North Star determinism: e.g.
`generate_clip.validate` checks "this beat declares a main character → an active
anchor selection of kind `character` must exist for it"; if missing it returns a
`PreconditionMiss`, **not** a thrown error and **not** silently doing the wrong
thing.

The existing functions map onto tools with minimal rewrap: `planEdit` →
`plan`; `planCompositionBeats` → composition planning inside `plan`;
`generateCharacterHeroFrame`/`generateBeatKeyframe`/`generateBeatClip`
(`oneshot/media-generation.ts`) → `generate_anchor`/`generate_keyframe`/
`generate_clip`; `generateSoundtrack` → `generate_audio`; the segment-mapping at
`route.ts:419` + `compileTimelineViaEditGraph` → `assemble_timeline`; `critique`
→ `critique`. The visual-review retry (`route.ts:113`) becomes the agent
reacting to a `regenerate` recommendation, not an inline `if`.

### 2. Error / self-heal protocol

```ts
type ToolErrorKind =
  | "precondition_unmet"   // a required input is missing → agent can satisfy it
  | "invalid_input"        // caller bug, not self-healable
  | "provider_quota"       // retry with fallback provider (today's isQuotaError)
  | "provider_failed"      // transient; retry/backoff
  | "budget_exceeded"      // pause + propose (see cost model)
  | "policy_violation";    // safety/forbidden-claim; surface, do not auto-retry

interface PreconditionMiss {
  requirement: string;        // "character_likeness"
  because: string;            // human-readable, fed to the agent
  // The tool the agent should call to satisfy it, with suggested input. This is
  // what makes the miss *actionable* and ordering *emergent* (Principle 7).
  satisfyWith: { tool: ToolName; inputHint: Record<string, unknown> };
}

interface ToolError {
  kind: ToolErrorKind;
  message: string;
  misses?: PreconditionMiss[];   // for precondition_unmet
  retryable: boolean;
  retryHint?: { tool?: ToolName; provider?: string; backoffMs?: number };
}
```

Self-heal loop, per the North Star worked example:
`generate_clip(beat 3)` → `validate` finds no character anchor →
`{ kind: "precondition_unmet", misses: [{ requirement: "character_likeness",
satisfyWith: { tool: "generate_anchor", ... } }] }` → the **orchestrator
generates the anchor, then retries `generate_clip`.** Step order is therefore
*emergent from the contracts*, not coded into `route.ts`/`execute.ts`. This
generalizes today's two ad-hoc heals: `provider_quota` carries the fallback hint
(replacing `route.ts:354-394`), and the `VideoSnapshotReview.recommendedAction`
becomes a soft signal the agent weighs (replacing the `if` at `route.ts:148`).

Reuse `describeError`'s shape from `execute.ts:284` (`code/message/retryable`) so
run-store stage errors (`GenerationErrorSummary`, `runs/types.ts`) and tool
errors share one taxonomy.

### 3. The orchestrator loop

A single agent loop replaces both hardcoded pipelines (host engine from the
unified-engine lane). Pseudocode:

```
state = { goal, brief, pool, graph, budget }
goal_satisfied = false
while not goal_satisfied and not paused:
  decision = agent.next(state, available_tools, candidate_stale_set)
    // agent picks ONE tool call (or proposes a multi-step plan), given the
    // pool (by ID), provenance, the candidate-stale set, and remaining budget.
  if decision is a proposal (expensive/fan-out): emit Proposal; await approval
  result = tool.validate(...) then guardrail.check(estimate) then tool.run(...)
  if result.error.kind == "precondition_unmet":
    state += satisfy(miss.satisfyWith)   // emergent ordering / self-heal
    continue
  if result.error.kind == "provider_quota": retry with hint; continue
  if result.error.kind == "budget_exceeded": pause + propose; continue
  state.pool += result.assetIds          // nothing throwaway (Principle 9)
  goal_satisfied = agent.assess(state)
```

Properties:

- **Autonomous by default** (Principle 2): no gates → runs straight through,
  reproducing today's one-shot behavior, just observable. Opt-in gates (shared
  with inspection-feedback) pause before a chosen step.
- **First-pass ordering is emergent, not hardcoded.** The agent starts from a
  sensible default (`plan` first) but the *actual* sequence falls out of what
  each tool's `validate` says it needs (Principle 7, §8 "First pass vs edits"
  decision).
- **On change → minimal re-run.** The candidate-stale set from provenance-graph
  is passed in; the agent makes the final call and may prune cascades it judges
  irrelevant (Principle 3). It expresses the re-run via the regeneration
  vocabulary, then **proposes** before spending (Principle 5).
- **Higher-order decomposition** (Principle 8): deciding to split a long piece
  into parallel sub-videos is a strategy call the loop makes, invoking the
  composition lane's parallel primitives. (Model it; do not build feature-length
  tooling now.)

Implementation: this is the first place the codebase uses Anthropic **tool-use**
(today everything is `structuredCall` JSON, `anthropic.ts:49`). Add a
`toolLoopCall` alongside `structuredCall` exposing the tool registry as
`tools:`; keep the existing JSON calls for the leaf reasoning tools (`plan`,
`critique`) which the orchestrator invokes.

### 4. Regeneration vocabulary

Extend beyond timeline-forward `Patch` (`types.ts:270`) with an orchestrator-level
action union that operates on **pool assets and plan nodes by ID** (the IDs come
from provenance-graph), distinct from the segment-keyed `Patch`:

```ts
type RegenAction =
  | { op: "regenerate_asset"; assetId: string; overrides?: Partial<GenInput>; reason: string }
  | { op: "change_beat"; beatId: string; patch: Partial<Beat>; reason: string }
  | { op: "swap_anchor"; beatId: string; anchorId: string; reason: string }
  | { op: "rescore_audio"; audioId: string; targetDurationSec?: number; reason: string }
  | { op: "regenerate_keyframe"; beatId: string; reason: string };
```

Each `RegenAction` resolves to one or more tool calls and updates the active
selection in the pool (asset-pool lane: regeneration **adds** an asset and may
flip the slot pointer; the old asset stays reusable, §5/§8 decisions). `Patch`
stays for pure timeline re-cuts; `RegenAction` is the new layer for "go back and
re-make an upstream asset." Both flow through the orchestrator. Note `Beat` has
no stable id today (`types.ts:143`; today linked by `role` string) and
`editGraphBeatId(index, name)` (`edit-graph.ts:145`) is index-derived —
`change_beat`/`swap_anchor` are **blocked on provenance-graph adding stable beat
IDs.**

### 5. Cost model (crude, per §8 decision)

Three tiers, driven by `estimate()`:

- **Cheap → just run:** planning, images/anchors/keyframes, audio. (Images $0.05,
  audio ~$0.01/sec per `pricing.ts`.)
- **Expensive / fan-out → propose first:** video clips and big regenerations.
  Estimate via the existing rate: **~$0.50/sec** of generated video
  (`pricing.ts:27`, already the openai/gemini constant) × clamped seconds ×
  beat count, plus simple heuristics (e.g. add audio estimate). Use the **actual
  clamp ceiling**, not a 4–8s assumption: one-shot `clampSeconds`
  (`src/app/api/oneshot/config.ts:115-116`) delegates to
  `normalizeOpenAIVideoSeconds` (`src/lib/generative/types.ts:76-78`), which
  snaps to 4s (≤6s), 8s (≤10s), or **up to 12s** (>10s) — so per-clip estimates
  must allow up to 12s, or one-shot video spend is under-estimated. Emit a `Proposal { steps, estimatedUsd, reason }`; in interactive
  mode await approval, surfacing through the inspection-feedback UI.
- **Budget ceiling (autonomous mode):** the loop tracks cumulative `costUsd`
  (sum the per-asset `Clip.generatedBy.costUsd` already stamped at
  `execute.ts:152` + estimates for pending work). When a proposed step would
  cross the ceiling, return `budget_exceeded` → pause + ask.

```ts
interface CostEstimate { tier: "cheap" | "expensive"; usd: number; rationale: string; }
interface Proposal { steps: { tool: ToolName; estimate: CostEstimate }[]; totalUsd: number; reason: string; }
```

Keep it deliberately rough now (a rate + a couple of heuristics); refine when
videos routinely exceed ~1 minute. Centralize the math in one
`estimateRunCost(plan)` next to `estimateCostUsd` so both pipelines/the engine
share it.

## Work Breakdown (ordered, PR-sized)

> Sequenced so each PR is independently shippable and earlier PRs unblock later
> ones. Effort: **S** ≈ <0.5d, **M** ≈ 1–2d, **L** ≈ 3–5d.

1. **PR-OT1 — Tool contract types + registry (no behavior change). [S]**
   Add `ToolContract`, `ToolResult`, `ToolError`, `PreconditionMiss`,
   `CostEstimate`, `Proposal`, `RegenAction` types. No callers yet; pure scaffolding.
2. **PR-OT2 — Wrap existing stages as tools. [L]**
   Wrap `planEdit`/`planCompositionBeats`/`generate*`/`assemble`/`critique`
   (`agent/index.ts`, `oneshot/media-generation.ts`, the assembly at
   `route.ts:419`) in `ToolContract`s. Stub `validate` to `[]` and `estimate` to
   the cheap tier first — behavior unchanged. **Dedupe the drift** between
   `execute.ts:50-296` and `oneshot/*` into the shared tool bodies (coordinate
   with unified-engine).
3. **PR-OT3 — Precondition validation + structured `ToolError`. [M]**
   Implement real `validate` per tool — starting with the character-likeness
   precondition on `generate_clip` (today implicit at `route.ts:233-239`). Fold
   the `isQuotaError` swap (`route.ts:354`) into a `provider_quota` error +
   `retryHint`. Unify with `describeError` (`execute.ts:284`).
4. **PR-OT4 — Orchestrator loop (autonomous, no gates). [L]**
   Add `toolLoopCall` (Anthropic tool-use) in `anthropic.ts`; build the loop that
   plans → validates → self-heals → runs. Drive `/api/oneshot` + a run through
   it; emit run-store stage events from tool calls so the existing polling UI
   keeps working. Self-heal example (clip → anchor → retry) passes an
   integration test. *(Depends on unified-engine host.)*
5. **PR-OT5 — Cost model + proposals + budget ceiling. [M]**
   `estimateRunCost` next to `estimateCostUsd`; classify tools cheap/expensive;
   emit `Proposal` before video/fan-out; track cumulative spend; `budget_exceeded`
   pauses autonomous runs.
6. **PR-OT6 — Regeneration vocabulary wired to the loop. [M]**
   Implement `RegenAction` → tool-call resolution, updating active selections in
   the pool. Consume the candidate-stale set; agent prunes the cascade and
   proposes the minimal re-run. *(Depends on provenance-graph stable IDs +
   asset-pool selections.)*

## Dependencies & Sequencing

- **unified-engine** (hard, two-way): PR-OT2/OT4 assume one host engine to call
  the tools; their stage-unification *is* the rewrap of the drifted bodies.
  Sequence OT1–OT3 (types + wrapping + validation) in parallel with their P1, then
  land OT4 (the loop) onto the unified engine. Without it, the loop would still
  fork two pipelines.
- **provenance-graph** (hard): `change_beat`/`swap_anchor` need stable beat IDs
  (`Beat` has none today, `types.ts:143`); selective re-run needs the
  candidate-stale set. OT6 is blocked on this; OT1–OT5 are not.
- **asset-pool / store-consolidation** (hard for OT6, soft earlier): tools read
  by ID and write into the pool; `RegenAction` flips active selections. OT2 can
  start against today's `Project.clips` + `TimelineSegment.clipId` and migrate.
- **composition** (soft): the loop's parallel-decomposition strategy calls
  composition's recursive composite primitives; model the seam now, build later.
- **inspection-feedback** (soft): proposals/gate pauses are emitted by this loop
  and rendered by their UI; agree the event/proposal shape.

Recommended order: **OT1 → OT2 → OT3** (foundation, no behavior change, dedupes
drift) **→ OT4** (loop, with unified-engine) **→ OT5** (cost) **→ OT6** (regen
vocabulary, with provenance-graph + asset-pool).

## Risks & Open Questions

- **Tool-use reliability vs. today's JSON calls.** The repo has never used
  Anthropic tool-use (`anthropic.ts` is JSON-schema `structuredCall` only).
  Risk: loops that stall, over-call, or pick wrong tools. Mitigation: cap loop
  iterations, keep leaf reasoning as `structuredCall`, strong `validate` guards
  as the backstop, log every decision (Principle 9 audit trail).
- **Emergent ordering vs. a reliable first pass.** §8 resolves this (no hardcoded
  order; determinism in `validate`), but we must prove the agent reliably
  reaches a complete video without a scripted sequence. Mitigation: a "default
  recipe" prior the agent starts from, plus contract guards.
- **Idempotency without the full provenance fingerprints.** True idempotent
  re-runs depend on the provenance-graph fingerprints; until then, lean on the
  v1 `Idempotency-Key` seam and the `resumable*` helpers (`route.ts:233`).
- **Cost-estimate accuracy.** `$0.50/sec` is a hardcoded approximation
  (`pricing.ts:3-6` explicitly says "NOT live provider prices"). Proposals will
  be rough; acceptable per §8, but the budget ceiling could fire on a bad
  estimate. Keep the ceiling generous and the estimate visible.
- **Open: proposal granularity** — propose per expensive step, or batch the whole
  re-run plan? North Star Principle 5 reads as a single re-run plan; confirm with
  inspection-feedback.
- **Open: where the budget ceiling is configured** — per project, per run, env
  default? Defer to store-consolidation's project model.
- **Open: should `critique`/`VideoSnapshotReview.recommendedAction` feed the loop
  as a tool result or as observations the agent polls?** Affects how the
  self-heal signal (`route.ts:148`) is surfaced.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
