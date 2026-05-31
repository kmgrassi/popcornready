# Motion Preference Scope

## Objective

Standardize how the system decides, per beat, whether to generate a **video
clip** or a **still image**. Today this decision is half-controlled in one
pipeline and hard-coded in another; this scope unifies it behind a single
**motion preference** knob on the brief that:

1. Defaults to **AI-decides** — the planner chooses image vs. video per beat
   based on the brief's theme, context, and visual intent.
2. Lets the user override the *feel* of the run on a small categorical scale
   (image-forward → balanced → video-forward), not a hard ratio.
3. Flows into the cost estimate as an input, but is **not** itself a cost
   control — it is a creative-feel control whose downstream effect on cost is
   informational.

This extends the composition planner described in
[Agent Video Generation API](./agent-video-generation-api.md) and reuses the
existing per-beat `assetStrategy` / `generationKind` decision the planner
already makes; the knob shapes the planner's reasoning, it does not bypass it.

## Current State

Two pipelines decide image vs. video today, in two different ways:

**1. Composition planner (`src/lib/agent/composition.ts:21-37`).** The system
prompt gives the LLM three per-beat choices (`use_existing`, `generate_image`,
`generate_video`) and one piece of guidance:

> "Prefer generated images over generated video unless motion is essential,
> since images are cheaper and faster."

The LLM picks per beat. The choice is honored in
`src/lib/composition.ts:259-265`, then routed to the appropriate provider in
`src/lib/composition.ts:280-284`. Hard caps in `enforceCaps()`
(`src/lib/composition.ts:414-433`) prevent runaway counts (default: 10 images,
3 videos) but do not shape the mix.

**2. One-shot route (`src/app/api/oneshot/route.ts:138-162`).** The recently
landed landing-page path always generates **video** for every beat. There is no
image branch; the planner's per-beat decision is not consulted. This is the
path the landing prompt currently uses (commit `c5524b7`).

The result is that the only place a mixed image/video run can come from today
is the composition-planner pipeline, and even there the user has no way to
shift the feel — the single "prefer images" hint biases the mix in one
direction regardless of the brief's theme.

## Terminology

- **Motion preference:** a brief-level field describing how kinetic the run
  should feel. One of `auto`, `image-forward`, `balanced`, `video-forward`.
- **`auto` (default):** the planner decides image vs. video per beat from the
  brief's theme and context. No global tilt is applied.
- **Per-beat decision:** the planner still chooses, beat by beat, which medium
  fits — the motion preference shifts the planner's threshold, it does not
  prescribe a ratio or assign beats.
- **Image-dense / video-dense sections:** even on a `video-forward` run, some
  stretches may be image-heavy if the beats in that stretch don't call for
  motion. The knob is a global *bias*, not a per-beat instruction.

## Why A Preset, Not A 0–1 Slider

A numeric ratio (e.g. "0.4 of beats are video") is the wrong shape for two
reasons:

1. **It fights the per-beat decision.** The planner already does the right
   editorial work — "does this beat need motion?" — for each beat. A ratio
   forces a global count that the planner must then split across beats, which
   can put motion on the wrong beat just to satisfy the number.
2. **It quantizes badly on short runs.** A 3-beat video at "0.5" is ambiguous
   (1 video? 2?), and the user's intent ("a little less motion than balanced")
   is lost in rounding.

Presets sidestep both problems: each preset is a single line of guidance the
planner reads alongside the brief, and the planner is still in charge of
*which* beats get motion. The four levels are deliberately coarse so the user
controls the *flavor* and the planner controls the *placement*.

## Preset Semantics

Each preset replaces or augments the single guidance line in the planner's
system prompt. The exact wording is owned by the planner module; the spirit:

- **`auto`** *(default)*: "Choose image or video per beat based on the brief's
  theme and the intent of each beat. Consider whether the topic calls for
  kinetic energy or stillness. Do not default to one medium for cost reasons."
- **`image-forward`**: "Strongly prefer generated images. Use a generated video
  only for beats where motion is essential to the storytelling (e.g. a process,
  a reveal, a kinetic moment)."
- **`balanced`**: "Aim for a roughly even mix across the run. Use video for
  beats where motion adds meaning; use images for beats that read as a moment,
  a state, or a still image."
- **`video-forward`**: "Strongly prefer generated video. Use a still image only
  for beats that explicitly read better as a held frame (a portrait, a chart,
  a typographic moment)."

`auto` is the default because (a) the penicillin reference video produced a
good mix without any user input, and (b) the planner has more context about
each beat than the user does at brief-entry time.

## Where It Threads Through

### Brief schema

Add a single field to whatever object represents the brief at run creation
(today: the create-run body, eventually the `Brief` type referenced in
[API Contract V1](./api-contract-v1.md)):

```ts
type MotionPreference = "auto" | "image-forward" | "balanced" | "video-forward";

interface Brief {
  // ...existing fields...
  motionPreference?: MotionPreference; // default: "auto"
}
```

Omitting the field is equivalent to `auto`. Validation rejects unknown values.

### Composition planner

`planCompositionBeats` (in `src/lib/agent/composition.ts`) accepts
`motionPreference` and appends the corresponding guidance to its system
prompt, **replacing** the current "prefer images unless motion is essential"
line. The mode guidance (`MODE_GUIDANCE`) is unchanged; the new line slots in
alongside it.

### One-shot route

The one-shot path (`src/app/api/oneshot/route.ts`) is currently video-only and
does not run the composition planner. Two options (see Open Decisions):

- **Recommended:** route the landing prompt through `planCompositionBeats` so
  the motion preference takes effect there too, and add an image branch to
  `generateBeatClip` for beats the planner marks `generate_image`. This
  reunifies the two pipelines around one decision point.
- **Alternative:** leave one-shot video-only and make `motionPreference`
  silently inert there until the pipelines are merged.

Without the recommended change, the new knob is a no-op for the most common
entry path (the landing prompt), which would undermine the whole point.

### Cost estimate

Cost estimation (downstream, not in scope here) reads the planner's *output*
(`generationKind` per beat) and prices each beat accordingly. Motion preference
shapes that output but is not itself a pricing input — the user sees the cost
swing as a *consequence* of their feel choice, not as a direct knob.

## API Scope

All under the existing `/api/v1` run surface.

### Configure motion preference at run creation

```jsonc
POST /api/v1/projects/:projectId/generation-runs
{
  "prompt": "How penicillin was discovered...",
  "motionPreference": "balanced"  // optional; omitted = "auto"
}
```

The value is persisted on the run (or the brief version it produces) so a
later replay or audit can see what the user asked for.

### Read motion preference

Included in the run/brief payload returned by existing GET endpoints so the UI
can show the current selection and re-apply it on retry.

## UI Scope

Surfaced in whatever pre-run configuration step the user passes through (today
that is being defined alongside
[Generation Review Checkpoints](./generation-review-checkpoints.md); the knob
can live on the same screen):

- A single 4-option control labeled **Motion** with values **Auto**,
  **Image-forward**, **Balanced**, **Video-forward**.
- Default: **Auto**, described as "the agent decides based on your topic."
- A short helper line near the cost estimate explains that motion preference
  shifts the estimate ("video beats cost more than image beats").
- The selection persists into the run payload and the displayed plan, so the
  user can see *which beats the planner made video* after the fact.

## Proposed PR Sequence

Each PR is independently shippable and leaves the product working. PRs 1–3
make the planner motion-aware; PRs 4–5 propagate the knob through the
landing/one-shot path and the UI.

### PR 1: Add `MotionPreference` type and brief field

Add the `MotionPreference` union and the optional `motionPreference` field to
the relevant brief/create-run types. No behavior change yet.

Acceptance criteria:

- Types compile and are exported for server and client.
- Existing payloads remain valid (field is optional, defaults to `auto`).
- Invalid values fail validation at the API boundary.

### PR 2: Thread the preference into `planCompositionBeats`

Accept `motionPreference` as an input to `planCompositionBeats` and emit the
matching guidance line in the planner's system prompt, replacing the current
fixed "prefer images" hint.

Acceptance criteria:

- The planner system prompt contains the right line for each preset.
- `auto` runs produce a mix comparable to today's reference cases (e.g. the
  penicillin video).
- Extreme presets (`image-forward`, `video-forward`) measurably tilt the mix
  in the right direction on a sample of briefs.
- The existing `MODE_GUIDANCE` behavior is unchanged.

### PR 3: Persist and surface the preference on the run

Store `motionPreference` on the run/brief so the UI and audits can read it,
and include it in run GET responses.

Acceptance criteria:

- A run created with a preference reads it back unchanged.
- The progress UI can display "Motion: balanced" without extra calls.
- Older runs without the field render as `auto`.

### PR 4: Reunify one-shot with the planner (or document the gap)

Route the landing/one-shot prompt through `planCompositionBeats` and add an
image branch to `generateBeatClip` so `generate_image` beats produce stills.
If this is deferred, instead document that `motionPreference` has no effect on
the one-shot path until a follow-up.

Acceptance criteria:

- A landing-prompt run with `motionPreference: image-forward` produces stills
  for beats where motion is not essential.
- A run with `motionPreference: video-forward` produces video for every beat
  where it is reasonable (matching today's all-video behavior).
- Errors in the image branch fall back or fail cleanly without breaking the
  run.

### PR 5: Motion control in the pre-run UI

Add the 4-option Motion control to the pre-run configuration step, default to
Auto, and wire it into the create-run call.

Acceptance criteria:

- Submitting a prompt with the default produces an `auto` run.
- Each preset round-trips through the API and shows up in the run payload.
- The cost estimate (when present) updates in response to changes.

## Open Decisions

- **One-shot reunification (PR 4):** do we merge the one-shot path back into
  the composition planner now, or ship the knob as planner-only and accept
  that it is inert for the landing prompt until a later PR?
- **`auto` system-prompt wording:** should `auto` explicitly tell the planner
  to "consider whether the topic calls for kinetic energy or stillness," or
  stay silent and let the planner default to its own judgment? Explicit is
  recommended (it's the cheapest nudge toward the penicillin-style mix), but
  it changes behavior for existing runs.
- **Five levels vs. four:** is `balanced` distinct enough from `auto` to
  warrant both, or should `auto` *be* the balanced setting? Keeping them
  separate is recommended — `auto` reads as "agent picks the feel" while
  `balanced` reads as "I want a mix" — but it is the closest pair.
- **Per-beat override:** in the eventual edit graph (see
  [AI-Native Edit Graph](./ai-native-edit-graph.md)) the user may want to flip
  a single beat from image to video without changing the global preference.
  Scope of that override lives there, not here.
- **Caps interaction:** `video-forward` on a long run will hit the
  `maxGeneratedVideos` cap (default 3) before it can express the preference.
  Should the cap auto-scale with the preference, or stay fixed and surface as
  a planner error the way it does today?

## Risks

- **Knob fights local decisions.** If the preset's wording is too strong, the
  planner will pick the same medium for every beat regardless of intent. The
  preset wording should bias, not command. PR 2's acceptance bar — that
  `auto` still produces a sensible mix on the reference brief — catches the
  worst case.
- **One-shot mismatch.** If PR 4 is deferred, the most-used entry path
  ignores the new knob, which is worse than not shipping it. Either ship PR 4
  or surface the limitation in the UI (e.g. disable the control when the
  selected pipeline is one-shot).
- **Cost surprise.** A user who picks `video-forward` for feel may be
  shocked by the cost. The cost estimate must update visibly when the
  preference changes, or this becomes a footgun.
- **Cap collisions.** A strong preset that exceeds `maxGeneratedVideos`
  results in a planner error today, not a graceful degrade. Until the cap
  question is decided, the UI should communicate the cap clearly.

## Acceptance Criteria

- A user can choose a motion preference on a new run, or accept the default of
  `auto`.
- `auto` runs produce a sensible mix of images and video chosen by the planner
  from the brief's theme — matching the quality of today's best reference
  runs.
- `image-forward` and `video-forward` runs measurably tilt the mix in the
  right direction without forcing the planner to put motion on inappropriate
  beats.
- The preference round-trips through the API, is visible on the run payload,
  and is reflected in the cost estimate.
- Existing runs with no `motionPreference` field continue to work and are
  treated as `auto`.
