# Stage Eval Framework — AI-as-Judge testing at every tool call

> **Status:** Scope / design. **Not implemented.** This is the design record for
> an evaluation framework that uses the AI to *test the AI* at every stage of
> generation. Last updated 2026-06-04.
>
> Decisions taken at scoping time (all resolved — see §9):
> 1. **Both modes, suite-first** — the primary deliverable is an offline
>    regression suite + dashboard, built on a Judgment record that *also* attaches
>    to live runs so inline verdicts come for free.
> 2. **Rubric-by-default, optional goldens** — every evaluator can judge
>    reference-free against a rubric + upstream intent; a case may *additionally*
>    carry expectations/golden artifacts for high-value regression.
> 3. **Hybrid enforcement** — cheap upstream stages (arc, characters, storyboard)
>    are synchronous blocking gates *before* expensive video gen; expensive
>    downstream outputs are async/sampled telemetry on live runs — sampled per
>    modality — text 100%, media judged per-clip starting at 100% (§3, §9.1, §9.5).
> 4. **Same judge model, context-isolated** — bias is controlled by what the judge
>    sees (asset + independent spec, never the generator's context), not by forcing
>    a different model; judge model pinned for reproducibility (§3, §9.2).
> 5. **Built in the monorepo** — `packages/eval` + `apps/api` + `apps/web`,
>    sequenced against the split: suite-first before the pipeline port, inline
>    gating after (§8). Monolith paths below cite where the judges live *today*,
>    before they extract to `packages/agent`.

## 1. Objective

Popcorn Ready produces **long-form video by stitching many short (≈5–10s)
AI-generated clips into one piece**, with the agent orchestrating each step:
plan a story arc → generate anchor/character images → generate per-beat
keyframes → generate per-beat clips → generate audio → assemble/stitch →
critique → export.

We want a framework that, **at every one of those steps / tool calls, uses the
AI to judge whether the step did its job** — *not* unit tests over fixed
strings, but an LLM-as-judge that reads the step's actual output (JSON, image
frames, the stitched cut) and grades it against the step's intent:

- At the **story-arc** step: did the AI produce a coherent, relevant arc for the
  goal?
- At **image / character generation**: did it generate the right subject,
  on-prompt, consistent?
- At **stitching / assembly**: did it cut the clips together correctly
  (continuity, order, pacing, no gaps)?

The framework runs these AI judges three ways off one shared verdict record: as a
**repeatable suite** (so we can catch quality regressions when prompts/models
change), **inline** on real generations (so every artifact shows its grade as it
pops), and from an **admin workbench** where a person drives one story through
the pipeline — cheaply, prompts-only by default — and fires the judge on each
asset individually to see how the agent is doing (§6C).

Non-goal: replacing the existing unit tests. Those stay (they guard
deterministic logic — patch application, edit-graph compilation, idempotency).
This framework covers the **non-deterministic, judgment** layer they can't.

## 2. The key insight — the judges already exist; the framework doesn't

Generation already runs as an **ordered stage machine** with a single
per-stage/per-item hook point, and several AI judges already exist inline — they
are just scattered, un-persisted as first-class evals, and not runnable as a
suite.

**Stage machine** (`src/lib/v1/types.ts`, `STAGE_ORDER`):

```
brief_intake → creative_plan → asset_generation → audio_generation
            → timeline_assembly → quality_review → export → ready
```

Every stage runs through a progress emitter — `RunStageHandle` /
`RunStageItemHandle` (`src/lib/v1/generation-progress.ts`) — with one terminal
call per stage/item. **This is the natural interception point the framework
hooks — but it is not evidence-bearing today**, which is a prerequisite we must
fix first (see "Evidence-bearing hook" below): item-level
`succeed({ assetId, artifactId })` *does* carry the produced media, but
**stage-level `succeed()` only takes a `message`** (`StageSucceedOptions`), and
text stages like `creative_plan` call `succeed()` with the plan held in a local
variable and **never persisted** (`apps/api/src/lib/v1/generation.ts:255-262`,
`generation-progress.ts:50-52`). So a judge that merely wraps `succeed()` would
have **nothing to evaluate** for story-arc or timeline-assembly. The hook must be
made evidence-bearing before judging rides on it.

**Judges that already exist** (reuse, don't rebuild):

| Step | Existing judge | File | Output shape |
| --- | --- | --- | --- |
| Story arc (plan) | `critiquePlan()` → `PlanCritiqueReport` | `src/lib/agent/index.ts` | `storyArc`, `characterContinuity`, `promptReadiness`, `visualFeasibility`, `issues[]`, `revisedPlan` |
| Asset gen (pre) | `preflightGenerationContent()` | `src/lib/generative/preflight.ts` | per-pass `issues[]`, revised prompt/description |
| Asset gen (post, vision) | `reviewGeneratedVideoSnapshots()` → `VideoSnapshotReview` | `src/lib/generative/video-snapshot-review.ts` | `storyMatch`, `characterMatch`, `visualQuality`, `recommendedAction`, extracted `snapshots[]` |
| Prompt quality | `eval-prompt-grader.ts` + `prompt-grading` scope | `scripts/eval-prompt-grader.ts`, `docs/scopes/prompt-grading.md` | per-modality dimension scores (0–10), verdict-match harness |
| Assembly / cut | `critique()` → `CriticReport` | `src/lib/agent/index.ts` | `hook_score`, `clarity_score`, `pacing_score`, `visual_variety`, `script_coverage`, `emotional_arc`, `repetition_penalty` |
| **Stitching continuity** | **— gap —** | — | no judge that the *stitched* output is continuous across cut boundaries |

All of them call one helper — `structuredCall<T>({ cachedSystem, user, schema })`
(`src/lib/anthropic.ts`, schema-validated, prompt-cached) — plus
`structuredVisionCall` for frame-based judging. **A new Evaluator abstraction is
a thin formalization of a pattern already used five times.**

So the work is: (1) a uniform **Evaluator/Verdict** abstraction + a **registry**
keyed by stage/tool; (2) persist verdicts as first-class **Judgment** records on
the run graph; (3) an offline **suite runner** over curated fixtures; (4) the
**UI**; (5) fill the **stitching-judge** gap.

## 3. Data model

The unifying record is a **Judgment** — one AI judge's verdict on one
stage/tool output. It attaches identically whether produced by a *live* run
(inline) or a *fixture-driven* eval run (regression). One shape, two sources.

### Evaluator (code/registry, not a DB row)

```ts
interface Evaluator {
  id: string;                       // e.g. "story_arc.v2"
  stageType: GenerationStageType;   // which stage it judges
  tool?: string;                    // finer than stage when a stage has many tools
  modality: "plan" | "image" | "video" | "audio" | "timeline";
  rubricVersion: string;            // bump to invalidate trend comparisons
  judgeModel: string;               // pin the judge model for reproducibility
  schema: JSONSchema;               // the structured verdict shape
  evidenceNeeded: EvidenceKind[];   // ["artifact_json"|"frames"|"rendered_preview"|"boundary_frames"]
  style: "reference_free" | "expectation_aware";
  mode: "blocking_gate" | "observational"; // sync gate before expensive work vs async telemetry
  thresholds: Record<string, number>; // per-dimension pass floors
  run(ctx: EvaluatorContext): Promise<JudgmentDraft>; // ctx is context-isolated — see §3
}
```

The registry is `stageType (+ tool) → Evaluator[]`. Adding judging to a new tool
= registering an Evaluator; no changes at the call sites.

### Judgment (immutable, append-only row — the core record)

```ts
interface Judgment {
  id: string;
  evaluatorId: string;
  rubricVersion: string;
  judgeModel: string;

  // exactly one provenance side — same row type for inline and offline:
  generationRunId?: string;         // inline: a real run
  evalRunId?: string;               // offline: a suite run
  caseId?: string;                  // offline: which case

  // the graph node it judged (reuses the existing run/stage/item/artifact ids):
  stageId: string;
  itemId?: string;
  artifactId?: string;
  assetId?: string;

  grades: Record<string, number | "pass" | "needs_review" | "fail">;
  verdict: "pass" | "needs_review" | "fail";   // recomputed from grades, never trusted from the model
  rationale: string;
  recommendedAction?: "keep" | "regenerate" | "manual_review";
  evidenceRef?: string;             // pointer to the JSON/frames the judge saw
  trigger: "auto" | "manual";       // auto = stage hook / suite; manual = admin fired it from the workbench (§6C)

  costUsd: number;
  latencyMs: number;
  createdAt: string;                // append-only; a re-judge adds a row
}
```

### Suite / case / run (the offline regression layer)

```ts
interface EvalSuite { id: string; name: string; description?: string; }

interface EvalCase {
  id: string;
  suiteId: string;
  label: string;
  stimulus:                          // what the case feeds in
    | { kind: "brief"; goal: string; targetLengthSec: number; style: string; aspectRatio: string }
    | { kind: "frozen_artifact"; stageType: GenerationStageType; artifact: unknown }; // start mid-pipeline
  stagesToRun: GenerationStageType[]; // which steps to exercise + judge
  expectations?: CaseExpectation[];  // OPTIONAL — see §4
}

interface CaseExpectation {
  stageType: GenerationStageType;
  // any of:
  gradeFloors?: Record<string, number>;        // "storyArc must be >= pass"
  goldenArtifactId?: string;                    // compare-to-golden
  assertions?: string[];                        // natural-language must-holds the judge checks
}

interface EvalRun {                  // mirrors GenerationRun — covers the batch suite AND a manual workbench session
  id: string;
  source: "suite" | "manual_workbench"; // batch regression vs an admin driving one story by hand (§6C)
  suiteId?: string;                 // set when source = "suite"
  generationMode: "prompts_only" | "full"; // prompts_only skips expensive provider calls — judge the specs without video spend
  stopAfter?: GenerationStageType;  // debug/test breakpoint: halt after this stage and await continue (unset = autonomous)
  gitSha: string;
  branch: string;
  judgeModels: Record<string, string>; // evaluatorId → model, for reproducibility
  status: "queued" | "running" | "succeeded" | "failed";
  aggregate?: Record<string, number>;  // pass rate per stage/dimension
  createdAt: string;
  completedAt?: string;
}

interface ExpectationResult {        // grades the JUDGE (meta-eval), only when a case has expectations
  evalRunId: string;
  caseId: string;
  judgmentId: string;
  matched: boolean;                  // did the verdict match the expectation?
  detail?: string;
}
```

### Design principles (consistent with `docs/NORTH_STAR.md`)

- **Judgments are immutable and append-only** — same philosophy as the asset
  pool. Re-judging adds a row; nothing is overwritten. The regression trend falls
  out for free.
- **The Evaluator declares the evidence it needs**, the framework gathers it.
  Plan/assembly judges read JSON; image/clip judges need extracted frames (reuse
  the ffmpeg path in `video-snapshot-review.ts`); the **stitching judge needs
  boundary frames** (the last frame of clip N + first frame of clip N+1) plus the
  timeline.
- **Evidence-bearing hook (prerequisite — do this first).** The judge can only
  run if the thing it judges is *available and persisted* at the hook. Today it is
  not for text stages: `StageSucceedOptions` is `{ message }` only, and
  `creative_plan` succeeds with the plan in a local var, unpersisted
  (`apps/api/src/lib/v1/generation.ts:255-262`). So **before** wiring evaluators,
  every stage/tool must emit its output as a **persisted, addressable artifact**:
  extend the terminal call to carry a result artifact
  (`StageSucceedOptions.resultArtifactId`, mirroring the item-level
  `assetId`/`artifactId`) and persist the stage's output (plan, timeline, …) as a
  first-class artifact keyed to the stage. This is **no-regret** — it is exactly
  NORTH_STAR principle 9 ("nothing is throwaway — everything is persisted") and
  principle 4's "generation is a first-class node," which the un-persisted plan
  already violates. The eval framework is the forcing function, not the owner.
- **One hook point (once evidence-bearing).** With each stage/tool persisting its
  artifact, wrap the progress emitter so that on every `stage.succeed()` /
  `item.succeed()` the registered evaluator(s) read the just-persisted artifact,
  fire, and write Judgments. **Inline mode** = real `runGenerationJob`
  (`src/lib/v1/generation.ts`). **Offline mode** = a harness that drives a
  fixture through the same stages behind the same hook. This is how we get "a
  test at every tool call" without scattering assertions — *provided* the
  prerequisite above lands first.
- **Hybrid enforcement — gate the cheap upstream, observe the expensive
  downstream.** Each evaluator has a `mode`. Stages *before the high-cost video
  fan-out* — story arc/plan, character anchors, keyframes/storyboard — are
  `blocking_gate`: judged synchronously, and a `fail` enters a review gate /
  self-heal regen **before any expensive generation runs** (never burn video
  spend on a broken arc or a wrong character). Expensive/downstream outputs
  (per-beat clips, final cut) are `observational` on live runs: judged
  async-after, never blocking, and **sampled per modality** — text/structured at
  100%, media judged per-clip (the per-beat clip is the unit; start 100%, ramp
  down — §9.5). The **gating boundary sits
  right before video generation.** In the suite, every evaluator runs synchronously regardless
  of `mode`. Reuses the existing `reviewGates` mechanism in the run model.
- **Context isolation is the bias guard — not a different model.** The judge gets
  a **clean slate**: only (a) the artifact under test and (b) an
  independently-derived spec of *what it should be* — and **never** the
  generator's prompt, chain-of-thought, or working context. Judging blind to how
  the asset was made removes most self-preference bias without forcing a different
  judge family, and judging against *intent* (not the prompt actually used) also
  catches a bad prompt. `EvaluatorContext` is built from a clean derivation of
  intent, never threaded through from the generation call. The judge model is
  still **pinned** per evaluator for trend reproducibility; calibration (§5)
  confirms it isn't lenient.
- **The verdict is recomputed deterministically from grades**, never read from
  the model's own `passed` field (the `eval-prompt-grader.ts` `computePassed`
  pattern). The judge supplies scores + rationale; the framework decides pass/fail.
- **Bounded execution for debug/test — autonomous by default, stops are opt-in.**
  The normal production path runs straight through (`docs/NORTH_STAR.md`
  principle 2). For debugging and for tests, the run input carries opt-in
  execution controls that the autonomous path simply leaves unset:
  - **`stopAfter` — a breakpoint at a stage boundary.** Halt after a named stage
    (e.g. `creative_plan`) and **await an explicit continue**, so a human or the
    suite can inspect/judge the artifact before any further (and any expensive)
    work runs. Reuses the same pause plumbing as `reviewGates` (the run sits
    paused; a `continue` resumes it) — it differs only in *intent*: a debug/test
    breakpoint, not a human review gate.
  - **`prompts_only` — a dry-run depth.** A special, common stop: run plan +
    per-asset prompt construction + `preflight`, but **stop before any provider
    call**, producing the specs without media spend. This is the workbench's
    default (§6C) and is just the cheap end of the same bounded-execution control.

  Both are knobs on the *one engine* (the live `GenerationRun` and the
  fixture-driven `EvalRun` share them), so a debug run, a test run, and a
  production run differ only by which stops are set — never by a separate code
  path.

### Storage

Target Supabase (the cutover is in flight — see `docs/scopes/auth-app-architecture.md`
/ the supabase work). New tables: `eval_suites`, `eval_cases`, `eval_runs`,
`judgments`, `expectation_results`; **reuse** `generation_runs` / stages / items
for the graph nodes a Judgment points at. `judgments` is append-only.

## 4. Rubric-free vs expectation-based judging (both)

Two judging styles, per the scoping decision:

- **Reference-free (default).** The judge scores the output against a rubric +
  the **upstream intent** (the brief/plan/beat it was meant to satisfy). "Is this
  a relevant 3-act arc for goal X?" / "Does this keyframe depict beat 3's subject
  on-prompt?" No golden to maintain; works for any goal. This is what every
  existing judge does.
- **Expectation-aware (opt-in per case).** A case additionally carries
  `expectations` — grade floors, a golden artifact, or natural-language
  assertions ("the arc must resolve the conflict introduced in beat 1"). The
  judge is given the expectation as part of its context, and an
  `ExpectationResult` records whether the verdict matched. Use this for
  high-value regression cases where you want a hard signal that a specific
  behavior didn't drift.

Most suite cases will be reference-free; a curated minority carry expectations.

## 5. Grading the judge (meta-eval — required, because the test is an AI)

Because the "test" is itself an LLM, a judge that rubber-stamps everything is
worse than no test. So the suite includes **labeled fixtures with known
answers** — both *good* outputs and **deliberately broken** ones (a scrambled
story arc; a wrong-character keyframe; a cut with a continuity break) — and we
measure whether each judge **catches the known-bad cases** and **passes the
known-good ones**. That match rate is the judge's calibration score
(`ExpectationResult` aggregated). `eval-prompt-grader.ts` already does exactly
this for prompt grading (verdict-match against 27 expected cases); we generalize
the pattern to every stage. A rubric/model change that drops a judge's
calibration is itself a regression.

## 6. UI

Three surfaces, all sharing the Judgment data: (A) inline badges on live runs,
(B) the batch suite dashboard, and (C) the admin workbench for driving one story
interactively, judgment by judgment.

### A. Inline — verdict badges on the run view

The existing generation-run page (stages + items, polling `GenerationRunPayload`
— see `docs/scopes/generation-progress-ui.md`) gains a verdict chip per
stage/item:

- 🟢 pass · 🟡 needs-review · 🔴 fail, expanding to: dimension scores, the
  judge's rationale, **the evidence it saw** (the JSON or the frames), the
  recommended action, and a **regenerate** button.
- Directly delivers `docs/NORTH_STAR.md` P3 ("artifacts visible as they pop;
  approve/regenerate any stage"); the verdict can optionally drive an automatic
  review gate (`reviewGates` already exist in the run model).

### B. Eval suite dashboard (the "test framework" proper)

- **Suite list** — each suite shows latest pass rate + a per-stage trend
  sparkline over recent eval runs.
- **Run detail** — a `cases × stages` grid; each cell a verdict; click to drill
  into the evidence + the judge's rationale.
- **Diff two runs** — which verdicts flipped before/after a prompt/model change.
  *This is the money view:* "did my prompt edit regress story-arc quality?"
- **Case authoring** — define a case (goal + stages + optional expectations),
  plus a **"save this live run as a regression case"** button that freezes a real
  run's inputs/artifacts into a fixture (the `frozen_artifact` stimulus).
- **Judge calibration** — the meta-eval match rate (§5), so the team trusts the
  judges before trusting their verdicts.

### C. Admin eval workbench (interactive, one story at a time)

The hands-on counterpart to the batch suite: an **admin-only** workbench where a
person drives a single story through the pipeline and judges each artifact
individually to *see how the agent is doing*. This is the original "manually
tested framework" — a UI, human-paced, one-by-one.

Flow:

1. **Pick / author a story.** Choose an existing brief or type a goal
   (length/style/aspect). This seeds a `manual_workbench` `EvalRun`.
2. **Generate — prompts-only by default.** The generation agent runs the stages,
   but in **`prompts_only` mode** it produces *the prompts/specs for every asset*
   (the plan/story arc, each anchor prompt, each beat keyframe prompt, each beat
   clip prompt, audio spec) **without calling the expensive video/image
   providers**. A **"generate for real"** toggle escalates a chosen beat (or the
   whole story) to actual media when the admin wants to inspect pixels. So the
   default loop costs pennies (text only) and only spends on media on demand.
3. **Walk the artifacts as they pop.** A stage-by-stage board lists every produced
   artifact (each beat's prompt, each generated asset) as a card — exactly the
   NORTH_STAR "artifacts visible as they pop" inspection view, but admin-driven.
4. **Judge each one individually.** Every card has a **"Run judge"** button that
   fires the registered evaluator for that artifact *on demand* (an `auto:false`,
   `trigger: "manual"` Judgment) — the **admin/judge agent** evaluates that single
   asset/prompt against its independent spec and returns the verdict + dimension
   scores + rationale + recommended action, inline on the card. Re-run, tweak the
   rubric, and re-judge freely; every run appends a Judgment (immutable history).
5. **Per-story scorecard.** A roll-up across stages — where the agent is strong /
   weak on *this* story — plus the judge-calibration signal if labeled.
6. **Promote to a regression case.** One click turns the (good or
   deliberately-bad) workbench run into a saved `EvalCase`, freezing its
   prompts/artifacts so the suite (B) replays it forever.

The admin can also **step the run stage-by-stage** using `stopAfter` (§3
principles): halt after `creative_plan`, judge the arc, then continue to the next
stage — a breakpoint walk through the pipeline.

This needs three things beyond the suite: the **bounded-execution controls**
(`stopAfter` breakpoints + the `prompts_only` dry-run — both from §3, both on the
shared engine), and an **on-demand single-artifact judge endpoint**
(`POST …/judgments { evaluatorId, artifactId }`) that the "Run judge" button and
the inline "re-judge" action both call.

Home: the web app — `apps/web` (Vite SPA) → `apps/api` v1 eval endpoints. The
batch dashboard (B) is a new `/evals` SPA route; the workbench (C) is an
admin-gated `/admin/evals` route (admin auth per `docs/scopes/auth-app-architecture.md`).
Both land once the eval API surface exists in `apps/api`; the suite harness
(§8 P1) is usable from the CLI before any dashboard ships.

## 7. The stitching judge (the one real gap)

Every other step has a judge; **stitching does not**. New evaluator
`stitch_continuity`:

- **Evidence:** boundary frames (last frame of clip N + first frame of clip N+1)
  across every cut, plus the assembled timeline/render plan and the plan's
  intended beat order.
- **Judges:** order correctness (clips in the planned beat sequence), continuity
  across cuts (subject/lighting/scene jumps that read as errors vs intentional
  cuts), pacing/duration adherence to the plan, gaps/overlaps, and audio sync if
  present.
- **Reuses:** the ffmpeg frame-extraction in `video-snapshot-review.ts` and
  `structuredVisionCall`. Output mirrors `VideoSnapshotReview`
  (`pass/needs_review/fail` + `recommendedAction`).

## 8. Phasing (monorepo; each independently shippable)

Built in the monorepo (decision §9.3). The split is mid-flight, so phasing is
ordered by what each piece needs from it:

- **Prereq — judges available in `packages/agent`.** Suite mode needs the judge
  functions (`critiquePlan`, `critique`, `video-snapshot-review`) extracted into
  `packages/agent` (the MIGRATION.md "extract shared packages" step). It does
  **not** need the live run pipeline.
- **P1 — Portable core + suite harness (no live pipeline needed).** New
  `packages/eval`: `Evaluator`/`Judgment`/registry + the context-isolated
  `EvaluatorContext`, and a CLI suite harness that drives fixtures through the
  judges and writes Judgments. Runnable as soon as the judges land in
  `packages/agent` — even before generation is ported to `apps/api`.
- **P2 prereq — evidence-bearing stages.** Make every stage/tool persist its
  output as an addressable artifact and carry it on the terminal call
  (`StageSucceedOptions.resultArtifactId`; persist the plan/timeline as
  first-class artifacts). Without this the inline hook has nothing to judge for
  text stages (see §3 "Evidence-bearing hook"). No-regret; aligns with NORTH_STAR
  principles 4 & 9. The CLI suite (P1) doesn't need it — it calls the judges
  directly — but inline gating and the workbench do.
- **P2 — Live inline gating + dashboard.** Lands when the generation stack
  (`runGenerationJob`, generation-runs) is ported into `apps/api/src/core`
  (MIGRATION.md route-parity work) **and** the P2 prereq above is in. Hook the
  ported progress emitter for the hybrid `blocking_gate` / `observational` modes;
  add the eval v1 endpoints and the `/evals` dashboard + run-diff in `apps/web`;
  "save live run as regression case."
- **P2b — Admin workbench (§6C) + bounded execution.** Adds the engine's
  **bounded-execution controls** — `stopAfter` stage breakpoints (reusing the
  `reviewGates` pause plumbing) and the **`prompts_only` dry-run** (plan +
  per-asset prompt construction + `preflight`, stopping before provider calls) —
  the **on-demand single-artifact judge endpoint**, and the admin-gated
  `/admin/evals` UI (story picker → prompts-only / step-by-step generate →
  per-card "Run judge" → per-story scorecard → promote-to-case). Shares the eval
  API + Judgment record from P2; the net-new engine capability is the
  bounded-execution stop controls. The autonomous production path leaves them
  unset, so this adds no behavior change to normal runs.
- **P3 — Expectations + judge calibration + the stitching judge.**
  `CaseExpectation`/`ExpectationResult`, labeled good/broken fixtures, the
  `stitch_continuity` evaluator, and a CI gate that fails on regression /
  calibration drop.

## 9. Decisions (resolved 2026-06-04)

1. **Hybrid inline judging.** Cheap, high-leverage upstream stages (story arc /
   plan, character anchors, keyframes/storyboard) are **synchronous blocking
   gates** that must pass before any high-cost video generation; expensive /
   downstream outputs are **async, sampled, observational** on live runs. The
   suite runs everything synchronously. (See the hybrid-enforcement principle in
   §3.)
2. **Same model, context-isolated.** No forced cross-family judge. Bias is
   controlled by giving the judge only the asset + an independently-derived spec
   of what it should be — never the generator's prompt/context. Judge model is
   pinned per evaluator for reproducibility; calibration (§5) guards leniency.
   (See the context-isolation principle in §3.)
3. **Built in the monorepo.** `packages/eval` (portable core) + `apps/api` (eval
   endpoints + live hook) + `apps/web` (`/evals` dashboard). Sequenced against the
   split — suite-first before the pipeline port, inline gating after (§8).
4. **Fixture media in a Supabase content-addressed `eval/` bucket.** sha256 keys,
   immutable, never deleted; text artifacts inline in the `eval_cases` row; on
   capture, media bytes are **copied** into the bucket (not referenced from the
   mutable project pool).

5. **Per-modality sampling (observational only).** Blocking gates always run at
   100%. Within *observational* judging, the sample rate **and granularity** are
   keyed by modality:
   - **Text/structured outputs — 100%.** Plans, prompts, story arcs, captions,
     timeline JSON: every one is judged (cheap, high signal).
   - **Media — one Judgment per clip, starting at 100% of clips.** The **per-beat
     clip is the sampling unit** (the slice): the framework judges *whole clips* —
     **not** the entire stitched video as one unit, and **not** sub-clip
     snippets/frames as separate samples (a clip's 20/50/80% frames are *evidence*
     for its single Judgment, not their own samples). **Start by judging 100% of
     clips**, then ramp the fraction down over time as throughput/cost grows. (The
     assembled cut is judged separately by the stitch-continuity evaluator, §7 —
     that is not part of this per-clip sampling.)

Still open:

- **Media ramp-down schedule** — *when* and *how* to drop the per-clip fraction
  below 100% (a throughput threshold or cost budget). The start is fixed at 100%
  and the unit is the clip (§9.5); only the ramp policy is open.
- **Ensemble upgrade** (2-judge `needs_review` tie-break) for high-stakes stages
  — deferred past P1.

## 10. Related reading

- `docs/NORTH_STAR.md` — §P3 inspection/gates, the asset-pool immutability model.
- `docs/scopes/prompt-grading.md` + `docs/scopes/prompt-grading-test-cases.md` —
  the existing per-modality rubric + verdict-match harness to generalize.
- `docs/scopes/video-snapshot-review.md` — the vision-judge + ffmpeg frame
  pattern the image/clip/stitch evaluators reuse.
- `docs/scopes/generation-review-checkpoints.md` + `generation-progress-ui.md` —
  the run/stage UI the inline badges extend.
- `docs/scopes/ooda-feedback-loop.md` — where judge verdicts can feed back into
  prompt/asset improvement.
