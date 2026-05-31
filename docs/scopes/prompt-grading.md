# Prompt Grading Scope

## Objective

Insert a standardized **grader** between every agent-authored prompt and the
generative provider call that consumes it (video, audio, image). The grader
scores the prompt against a fixed rubric and, if the score is below a
threshold, returns structured critique back to the originating agent so the
agent can rewrite and resubmit. The same grader contract is reused across
modalities — only the rubric and inputs differ.

Today the system already grades the *output* of a run with
[`critique()` in `src/lib/agent/index.ts`](../../src/lib/agent/index.ts):
that pass scores an assembled timeline. This scope adds the *missing first
half*: scoring the prompts that drive each individual asset generation **before
we spend the latency, cost, and provider quota** on a bad prompt. It is the
prompt-side analog of the timeline critic, and it slots cleanly into the
existing run/checkpoint model from
[Generation Review Checkpoints](./generation-review-checkpoints.md) and the
OODA loop in [OODA Feedback Loop](./ooda-feedback-loop.md).

## Current State

- Agent prompts for asset generation are constructed inline in route handlers
  and helpers — see `beatPrompt()` and `soundtrackPrompt()` in
  [`src/app/api/oneshot/route.ts`](../../src/app/api/oneshot/route.ts), the
  image/video edit prompts in [`generate-assets`](../../src/app/api/generate-assets/),
  and the character-aware prompt assembly that flows into
  [`src/lib/generative/providers.ts`](../../src/lib/generative/providers.ts).
- Prompts are passed straight to the provider (`providerFor(name).generateAsset(...)`)
  with no intermediate review.
- The only existing scoring is the post-assembly timeline critic
  ([`src/lib/agent/index.ts:141`](../../src/lib/agent/index.ts)) which produces a
  `CriticReport` of seven numeric scores and timeline patches — not prompt
  rewrites.
- Character-consistency review exists as a *post-hoc* concept on the generated
  asset (`CharacterConsistencyReview` in
  [`docs/scopes/character-consistency-generation.md`](./character-consistency-generation.md))
  but is not wired into a pre-generation grade.

## Product Principle

Every prompt that reaches a generative provider has been scored ≥ threshold
against a published rubric, or has been explicitly bypassed by the user. The
grade and its critique are first-class project data — visible in the UI, logged
with provenance, and replayable for evals.

## Terminology

- **Authoring agent:** the agent or helper that produced the prompt (planner,
  beat-prompt builder, soundtrack builder, character-aware image prompt
  builder, narration rewriter).
- **Grader:** the LLM-backed reviewer that scores a candidate prompt against
  the rubric for that prompt's `modality`.
- **Rubric:** the fixed, modality-specific set of scoring dimensions, each on a
  0–10 integer scale, with named, documented anchors.
- **Threshold:** the minimum overall (and per-dimension floor) score required
  to ship the prompt to the provider. Default 8.
- **Critique:** the structured feedback the grader returns when a prompt
  fails — strengths, weaknesses, and concrete rewrite guidance keyed to the
  failing rubric dimensions.
- **Revision loop:** authoring agent → grader → (pass | critique → authoring
  agent rewrite) → grader, bounded by a max-iteration cap.

## Where The Grader Hooks In

Two hook points, in order of priority:

1. **Per-asset prompt grading (V1, this scope).** Inside the asset generation
   step of a run — for each beat clip, each generated image, and each generated
   audio bed — call the grader with the candidate prompt before the provider
   call. Implemented as a wrapper around `providerFor(name).generateAsset(...)`
   so any caller (one-shot route, `generate-assets`, future agents) gets it for
   free.
2. **Plan-level coherence pass (V1.1, deferred but designed for).** After the
   per-asset grades pass but before any provider call fires, run a single
   *cross-asset* grade that sees every prompt in the batch and scores them as a
   storyboard. This is the only way to catch "clip 3 contradicts the arc of
   clips 1–2" failures that a per-asset grader cannot see.

The V1 implementation should be structured so the V1.1 pass is the same
grader function called with a different rubric and a bigger input — not a
parallel module.

## Tool Call vs Structured Output

**Decision: structured output, not tool calls.** Reasoning:

- The grader is a pure function of `(prompt, modality, context)` → `Grade`.
  There is nothing for it to fetch — all context (story brief, plan, prior
  accepted prompts, character profile) is in the project state and can be
  passed in the user message.
- The existing `structuredCall<T>()` helper in
  [`src/lib/anthropic.ts`](../../src/lib/anthropic.ts) is the same pattern used
  by every other agent in this repo (`planEdit`, `selectClips`, `critique`,
  `revise`). Reusing it keeps cache prefixes, JSON-schema validation, retry,
  and observability uniform.
- Tool calls add a round-trip and complicate retries without buying anything
  here. We would only reach for tools if the grader needed to pull live
  reference images, query a model registry, or call out to a separate
  embedding service — none of which V1 requires.

**Open question — flag for review:** if/when we add an image-similarity check
against the character reference pack (to score "would this prompt plausibly
match the reference faces?"), that step *is* a tool call (an embedding/vision
provider call). Plan the schema so a future `tools_used: ToolCall[]` field can
be added non-breakingly.

## Rubrics

All rubrics use **integer 0–10**, where:

- **0–3** = unusable, major rewrite required
- **4–6** = ships only with significant revision
- **7** = passable, minor revision recommended
- **8** = ship threshold (default)
- **9–10** = excellent

Each dimension has a one-line anchor description that goes into the grader's
system prompt so scores are calibrated.

**Universal pass rule.** A prompt only passes when **every dimension** is at or
above the run threshold. Overall is reported (weighted average) but is *not*
the pass test — a single dimension below threshold sends the prompt back for
revision, with the failing dimension(s) named in `rewriteGuidance`. This
prevents average-gaming (e.g. a 10 on `specificity` masking a 4 on
`brief_alignment`).

**Stricter safety/constraint floors.** Dimensions tagged as
`constraint_compliance` (video, image) and `safety_compliance` (audio) have an
additional **absolute floor of 8 regardless of the configured run threshold**.
Lowering the run threshold cannot lower these. A violation is disqualifying.

### Video Prompt Rubric

| Dimension | What it scores |
| --- | --- |
| `brief_alignment` | How closely the prompt, read literally, would yield a clip that matches the user's `goal` and `style`. |
| `beat_fit` | How well the prompt realizes *this specific beat's* `name` and `intent` from the `EditPlan`. |
| `storyboard_cohesion` | Whether the prompt names visual elements (subject, setting, framing, lighting, motion) consistent with the **shot before** and **shot after** in the plan. Catches "clip 3 is a totally different scene from clips 1–2." |
| `character_consistency` | If a `CharacterProfile` is bound to this beat: does the prompt reference the character's identity/wardrobe/style invariants and the provider reference mode correctly? If no character is bound: scored as N/A (10). |
| `production_quality` | Is the prompt specific about camera, lens/feel, lighting, composition, motion — the cues that separate "designed shot" from "stock generation"? Cross-checks `videoQualityContextForPrompt()`. |
| `constraint_compliance` | Aspect ratio, duration window, no-text-on-screen rule, brand/safety constraints from `StoryContext`. **Absolute floor of 8** — violation is disqualifying regardless of run threshold. |
| `specificity` | Concrete nouns and visual evidence vs. vague adjectives. Penalizes "cinematic beautiful inspiring." |

### Image Prompt Rubric

Same as video, **minus** `storyboard_cohesion` (still-image generations are
usually single beats), **plus**:

- `composition_intent` — does the prompt specify framing, focal point, depth,
  and negative space?

### Audio Prompt Rubric

| Dimension | What it scores |
| --- | --- |
| `brief_alignment` | Does the prompt match the goal and style of the video the audio supports? |
| `arc_fit` | Does the prompt describe rise/fall/tension matching the beat structure it underlays? |
| `mood_specificity` | Concrete instrumentation, tempo (BPM range), key/feel — vs. vague "upbeat positive." |
| `mix_constraints` | Vocals/no-vocals correctly specified, ducking/headroom for narration mentioned where applicable, duration matches target. |
| `safety_compliance` | **Absolute floor of 8.** Enforces the V1 audio safety blocklist (see below). Violation is disqualifying regardless of run threshold. |

#### V1 Audio Safety Blocklist

The grader sees this list in its cached system prompt and treats matches as
safety violations:

1. **Named artists** — no living or recently-active artists by name ("in the
   style of Taylor Swift," "like Hans Zimmer"). Genre/era descriptors are fine
   ("90s shoegaze," "modern cinematic orchestral").
2. **Song titles and lyrics** — no titles of known songs, no quoted lyric
   fragments.
3. **Recognizable hooks/riffs** — no "the four-chord progression from Let It
   Be," no "the bassline from Another One Bites the Dust."
4. **Label / soundtrack callouts** — no "sounds like a Marvel score," "a
   Disney opening," "Netflix-intro-style sting" (these encode specific
   copyrighted works).
5. **Voice impersonation** (forward-looking, for when we wire TTS) — no
   real-person voice cloning prompts, no "sound like [public figure]."
6. **Trademark sound marks** — no "the THX deep note," "the Intel bong," etc.
7. **Explicit content** — no profanity, slurs, sexual content, or glorified
   violence in lyric or mood prompts.
8. **Brand audio** — no jingles, no "the McDonald's I'm lovin' it tune."

Source for V1: hand-curated list maintained in `prompt-grader-rubrics.ts`,
versioned with the rubric (`audio.v1`). TODO when the safety story matures:
swap to a real safety-provider call (which *would* be a tool call — see the
note in **Tool Call vs Structured Output**).

### Cross-Asset / Storyboard Rubric (V1.1)

Run once per generation batch, after per-asset grading passes:

| Dimension | What it scores |
| --- | --- |
| `arc_continuity` | Do the prompts, read in order, tell a coherent story (setup → escalation → payoff)? |
| `visual_through_line` | Do shared subjects, palettes, and locations persist where they should? |
| `pacing_distribution` | Are wide/medium/close, action/static, and durations distributed sensibly across beats? |
| `outlier_detection` | **Explicitly identifies any single prompt that does not fit the rest** and returns its beat index in `outlierBeatIndices`. |
| `redundancy` | Are two prompts effectively asking for the same shot? |

## Grade Shape

```ts
type Modality = "video" | "image" | "audio";

interface PromptGrade {
  modality: Modality;
  schemaVersion: 1;
  overall: number;             // 0–10, integer, weighted average of dimensions
  dimensions: Record<string, number>; // keys per rubric above
  passed: boolean;             // overall >= threshold AND no hard-floor caps tripped
  threshold: number;           // echoed so logs are self-describing
  strengths: string[];         // 1–3 short bullets
  weaknesses: string[];        // 1–3 short bullets, only if !passed
  rewriteGuidance: string;     // free-text the authoring agent re-prompts with; "" if passed
  rubricVersion: string;       // "video.v1" etc.; bump when rubric changes
}

interface GradedPrompt {
  // The prompt that was finally shipped to the provider.
  finalPrompt: string;
  // Every grade along the loop, oldest first. Last entry is the one that passed
  // or the last one before bypass.
  grades: PromptGrade[];
  // Whether the loop terminated by passing, hitting max iterations, or user bypass.
  outcome: "passed" | "max_iterations" | "bypassed";
  iterations: number;
}
```

`PromptGrade` is the single shape the UI, logs, and future evals read.

## Revision Loop

```
authoring agent → candidate prompt
        │
        ▼
   grader.grade(prompt, modality, context)
        │
   ┌────┴─────────────────────────────┐
   │ passed?                          │
   ▼                                  ▼
 ship to provider           authoring agent.rewrite(prompt, grade.rewriteGuidance)
                                  │
                                  ▼
                            (loop, max N iterations)
```

Defaults:

- `threshold = 8`, applied per-dimension (a prompt passes only when every
  dimension ≥ threshold).
- `maxIterations = 2` (so up to **three** total prompt versions: original +
  two rewrites). Configurable per run.
- Safety/constraint dimensions enforce an absolute floor of 8 regardless of
  the configured run threshold — see rubric tables.
- The loop ships **the most recent prompt** when it terminates, even if an
  earlier iteration scored higher. Tracking `bestIndex` would be a small win
  for quality but a real loss in mental-model clarity; we explicitly choose
  the simpler rule.
- On `max_iterations`, the run does **not** silently ship the last prompt as a
  pass. It either (a) pauses for user review via the
  [Generation Review Checkpoints](./generation-review-checkpoints.md) gate, or
  (b) for YOLO runs, ships the last candidate and flags it in
  `CriticReport.warnings` with `outcome: "max_iterations"`.

The "rewrite" step is a new, small agent method on each authoring agent — not
a new global agent. The wrapper passes `rewriteGuidance` and the original
prompt; the agent returns a revised prompt. This keeps each authoring agent's
domain knowledge intact (the beat-prompt builder still knows what a beat is).

## Module Layout

```
src/lib/agent/
  prompt-grader.ts        // new — grade(prompt, modality, context) -> PromptGrade
  prompt-grader-rubrics.ts // new — rubric tables, anchor text, hard-floor rules
  prompt-grader-schemas.ts // new — JSON schemas for each modality's grade
src/lib/generative/
  graded-generate.ts      // new — wraps providerFor(name).generateAsset with the loop
src/app/api/oneshot/route.ts
  // change — replace direct provider.generateAsset(...) calls with graded version
src/app/api/generate-assets/route.ts
  // change — same
src/lib/types.ts
  // change — add PromptGrade, GradedPrompt; reference from Clip.generatedBy
```

`Clip.generatedBy` gets an optional `grade?: PromptGrade` (the passing one) and
`gradeHistory?: PromptGrade[]` (all attempts), so the timeline always knows
*how the prompt that produced this clip was reviewed*.

## Cost And Latency

A bad grader is worse than no grader — it doubles latency and burns cache.
Mitigations:

- The grader uses Sonnet 4.6 (small, fast) with prompt caching. The cached
  prefix is the modality's rubric block + a stable system preamble; the
  variable block is the candidate prompt + context. With caching, a per-asset
  grade should be < 1.5s and ~free relative to a video generation call.
- Per-asset grade is **skipped** when:
  - The user explicitly disabled grading for that run (config flag).
  - The prompt has been graded before in the same run with the same rubric
    version and inputs (memoized on `hash(prompt + context + rubricVersion)`).
- Cross-asset (V1.1) grader runs once per generation, not per asset.

Logged metrics per grade:

- `latency_ms`, `cache_hit`, `iterations`, `outcome`, `overall`, dimension
  scores, `tokens_in`, `tokens_out`, `rubric_version`.

## Integration With Review Checkpoints

The grader's pass/fail is **automated**; the
[Generation Review Checkpoints](./generation-review-checkpoints.md) gates are
**human**. They compose:

- If a stage is gated for review, the grader still runs and its result is
  shown to the human at the gate, with the option to edit the final prompt
  before approving.
- If a stage is not gated and the grader exhausts iterations without passing,
  the run **promotes itself to a gate** at that stage — the human is asked to
  decide whether to ship the best-scoring prompt, rewrite by hand, or cancel.
  This keeps "YOLO" runs honest: they only stop when the grader genuinely
  cannot find a passing prompt.

## Integration With OODA Loop

Each `PromptGrade` is a structured `FeedbackEvent` source for the OODA loop in
[`docs/scopes/ooda-feedback-loop.md`](./ooda-feedback-loop.md):

- Persistent low scores on a dimension (e.g. `production_quality` averaging 5
  across runs) signal that the authoring agent's prompt template needs an
  update — the kind of change Orient/Decide/Act is built to propose.
- Bypassed grades (user shipped a sub-threshold prompt anyway) are themselves
  signal: either the rubric is mis-calibrated or the user has a preference the
  rubric does not capture.

## Resolved Decisions

1. **Per-dimension pass rule.** Every dimension must clear the run threshold
   for a prompt to pass; the failing dimension(s) drive `rewriteGuidance`.
   Overall is reported but not gating.
2. **Threshold scope.** Single per-run threshold (default 8) applied uniformly
   across modalities and dimensions. Safety/constraint dimensions have an
   *additional* absolute floor of 8 that the run threshold cannot lower.
3. **Loop termination.** Always ship the most recent prompt — no "best so
   far" rewind. Earlier grades are preserved in `gradeHistory` for evals.
4. **Audio safety source.** Curated 8-item blocklist (see V1 Audio Safety
   Blocklist above), versioned with the rubric. Swap for a real safety
   provider later.

## Acceptance Criteria

- Every provider call out of `generate-assets`, `oneshot`, and any future
  generation route goes through `graded-generate.ts`. Direct
  `providerFor(...).generateAsset(...)` calls outside that wrapper are
  forbidden by lint or convention.
- Each generated `Clip` carries `generatedBy.grade` (the passing or final
  grade) and `generatedBy.gradeHistory`.
- Grader output is JSON-schema-valid for every run — invalid grader output is
  treated as a grader failure, not a prompt failure, and is logged and retried
  once.
- Threshold and max-iterations are configurable per run; defaults are 8 and 2.
- A regression test covers: (a) a prompt that passes first try, (b) a prompt
  that passes after one rewrite, (c) a prompt that exhausts iterations and
  triggers the YOLO-promotes-to-gate behavior, (d) a constraint-compliance
  hard-floor cap.
- Logs per grade include the metrics listed in **Cost And Latency**.

## Parallelizable Workstreams

Once this scope is approved, the implementation splits into these mostly
independent tracks. Numbers in brackets are rough effort (S/M/L).

**Track A — Grader core (M).**
- `prompt-grader-rubrics.ts` (tables, anchors, hard-floor rules).
- `prompt-grader-schemas.ts` (JSON Schema per modality).
- `prompt-grader.ts` (`grade(prompt, modality, context)` via `structuredCall`).
- Unit tests for schema validation and hard-floor logic.

**Track B — Authoring-agent rewrite methods (M).**
- Add a `rewriteWithCritique(originalPrompt, guidance, context)` method to
  each authoring helper: `beatPrompt`, `soundtrackPrompt`, character image
  prompt builder, narration rewriter (already has a rewrite shape — adapt).
- Unit tests that the rewrite preserves invariants (aspect, duration, etc.).

**Track C — Loop wrapper and provider integration (S).**
- `graded-generate.ts` wraps `providerFor(name).generateAsset(...)` with the
  loop, threshold, max-iterations, memoization.
- Swap call sites in `oneshot/route.ts` and `generate-assets/route.ts`.

**Track D — Type and storage changes (S).**
- Extend `Clip.generatedBy` with `grade` and `gradeHistory`.
- Extend `Project`/`CriticReport.warnings` for the YOLO-exhausted case.
- Migration note in store layer (file-based MVP — additive, no migration).

**Track E — Review-checkpoint integration (M, depends on A + C).**
- Surface the latest `PromptGrade` at gated stages.
- Implement YOLO-promotes-to-gate when iterations exhaust.
- Allow human edit of `finalPrompt` at the gate before approval.

**Track F — Observability and OODA hooks (S, depends on A).**
- Structured logs as listed in **Cost And Latency**.
- Emit a `FeedbackEvent` per grade so Orient sees them.

**Track G — V1.1 cross-asset / storyboard grader (M, depends on A).**
- Second rubric, same module, called once per batch.
- Promote to a separate scope before building if it grows beyond a rubric
  swap.

Tracks A, B, and D can start immediately and in parallel. C depends on A.
E and F depend on A and C. G can be deferred past V1.
