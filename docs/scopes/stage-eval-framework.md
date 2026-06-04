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

The framework runs these AI judges as a **repeatable suite** (so we can catch
quality regressions when prompts/models change) and **reuses the same verdicts
inline** on real generations (so every artifact shows its grade as it pops).

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
`RunStageItemHandle` (`src/lib/v1/generation-progress.ts`) — whose
`succeed({ artifactId, assetId })` is called exactly once per stage/item. **That
is the one interception point** the framework hooks.

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

interface EvalRun {                  // mirrors GenerationRun, for the suite
  id: string;
  suiteId: string;
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
- **One hook point.** Wrap the progress emitter so that on every
  `stage.succeed()` / `item.succeed(artifactId)` the registered evaluator(s) fire
  and write Judgments. **Inline mode** = real `runGenerationJob`
  (`src/lib/v1/generation.ts`). **Offline mode** = a harness that drives a
  fixture through the same stages behind the same hook. This is how we get "a
  test at every tool call" without scattering assertions.
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

Two surfaces, sharing the Judgment data.

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

Home: the web app — `apps/web` (Vite SPA) → `apps/api` v1 eval endpoints. The
dashboard is a new `/evals` SPA route. It lands once the eval API surface exists
in `apps/api`; the suite harness (§8 P1) is usable from the CLI before the
dashboard ships.

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
- **P2 — Live inline gating + dashboard.** Lands when the generation stack
  (`runGenerationJob`, generation-runs) is ported into `apps/api/src/core`
  (MIGRATION.md route-parity work). Hook the ported progress emitter for the
  hybrid `blocking_gate` / `observational` modes; add the eval v1 endpoints and
  the `/evals` dashboard + run-diff in `apps/web`; "save live run as regression
  case."
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
