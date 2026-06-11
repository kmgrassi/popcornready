# Poster generation — scope & PR plan

## Goal

Every project gets a **generated movie poster** without anyone asking: a
`generate_poster` tool the agent calls on every run, producing a `kind='poster'`
asset (theatrical 2:3 key art conditioned on the brief, plan, and hero anchor)
and auto-selecting it into the project-scoped `poster` selection slot. The
poster is the project's thumbnail in the dashboard grid and the click-through
to the watch page (see `docs/scopes/watch-the-movie.md`).

The display/data-model foundation already shipped (PR #292): the
`graph_asset_kind` enum has `poster`, the project-scoped `poster` selection
slot is the source of truth, `posterUrl`/`posterAssetId` are projected onto
`V1Project`, `POST /api/v1/projects/:projectId/poster` pins any ready image,
and the library grid renders 2:3 poster cards with fallbacks. This scope is
**only the generation side**.

## Alignment with NORTH_STAR

Per `docs/NORTH_STAR.md`, stages **are tools the agent calls**, runs are
autonomous by default, and any stage can be re-triggered with minimal
recompute. So:

- `generate_poster` is a **tool**, not a position on a conveyor belt. It is
  callable any time its inputs exist (brief at minimum), and the default run
  plan includes it on every run.
- Its output is a **versioned asset with provenance**: input edges to the
  brief/plan, an anchor edge to the hero anchor, `params` carrying
  provider/model/prompt, and `inputs_fingerprint` as the staleness signal.
- Re-runs are **fingerprint-gated**: if the brief, plan logline, and hero
  anchor are unchanged since the current poster was generated, the tool
  no-ops (the agent may still force-regenerate on explicit user ask).
- **Auto-select, but never stomp the user.** After generating, flip the
  `poster` selection via the CAS seq — *unless* the current selection was set
  by a human (`selections.set_by_action_id → actions.tool = 'set_poster'`).
  A manual pin wins until the user unpins.

## What already exists (reuse — do NOT reinvent)

- **Poster data model + write path** — `apps/api/src/lib/api/v1/store.ts`:
  `setProjectPoster()` (validates ready image, records a `set_poster` action,
  appends the selection), `projectPosterAsset()` resolution chain
  (selection → newest ready `poster` asset → newest ready image),
  `posterUrlFor()` signed-URL minting. Migrations
  `20260611000000_poster_asset_kind.sql` + `20260611001000_poster_kind_shape.sql`.
- **Generated-asset pipeline** — `apps/api/src/lib/api/v1/generated-assets.ts`
  `createGeneratedAsset()`: provider dispatch → bytes →
  `uploadAssetObject(generatedObjectPath(...))` → asset row + job. This is the
  entry every other media tool uses; the poster tool should too.
- **Image providers** — `apps/api/src/lib/generative/providers/openai.ts`
  (supports portrait 1024×1536) and `gemini.ts`. **Minor-safety rule
  (CLAUDE.md): photorealistic minors must go through Gemini**, same dispatch
  the keyframe path uses.
- **Hero anchor** — `apps/api/src/lib/api/v1/character-anchors.ts`
  `generateCharacterAnchor()`; anchors are pooled assets with role
  `character_anchor`, threaded into image generation as `referenceAssetIds`
  (see `apps/api/src/lib/api/v1/beats.ts` keyframe conditioning).
- **Run integration points** — `apps/api/src/lib/v1/generation.ts`
  `runGenerationJob()` (stage execution + `beginStage`/stage items) and
  `apps/api/src/lib/v1/generation/story-flow-tools.ts`
  (`StoryFlowToolName`, `buildStoryFlowToolPlan()` — the per-run tool plan).
- **Actions + selections** — `createAction()` / `setActiveAssetSelection()`
  in `store.ts` (the latter already accepts `slotRole: "poster"`).

## What must be built

- **A poster prompt builder.** Nothing composes "theatrical one-sheet" prompts
  today. New `apps/api/src/lib/generative/poster.ts`: `buildPosterPrompt(brief,
  plan?, hero?)` — genre/mood from the brief's style, logline from the plan,
  subject from the hero anchor. **No title text in the image** (image models
  render text badly); typography is a later renderer overlay.
- **The tool itself.** `generatePoster()` wrapping `createGeneratedAsset()`
  with `kind: "image"` → graph kind `poster`, portrait aspect, hero anchor as
  reference, provenance edges, then conditional auto-select.
- **Run wiring.** Nothing in `runGenerationJob` or the story-flow plan emits a
  poster.
- **Manual-pin detection.** A small store helper: "was the current poster
  selection set by a `set_poster` action?" (one join, used by auto-select).

## PRs

### PR P1 — `generate_poster` tool + endpoint

- **Files:** `apps/api/src/lib/generative/poster.ts` (new),
  `apps/api/src/lib/api/v1/store.ts` (pin-detection helper, poster asset
  insert + select), `apps/api/src/routes/v1/projects.ts`
  (`POST /projects/:projectId/poster/generate`).
- **Work:** prompt builder; `generatePoster({ auth, projectId, force? })` —
  loads brief/plan/hero anchor, fingerprint-gates unless `force`, generates via
  provider dispatch (Gemini when minors), uploads, inserts the `poster` asset
  with input/anchor edges and a `generate_poster` action, auto-selects unless
  manually pinned.
- **Done when:** hitting the endpoint on a project with a brief produces a
  ready `poster` asset, the selection flips, and the library grid shows it;
  calling again without changes no-ops; calling after a manual
  `POST /poster` pin does **not** flip the selection.

### PR P2 — every run generates a poster *(after P1)*

- **Files:** `apps/api/src/lib/v1/generation.ts`,
  `apps/api/src/lib/v1/generation/story-flow-tools.ts`,
  `packages/shared/src/v1/types.ts` (only if a stage item kind is needed).
- **Work:** add `"generate_poster"` to `StoryFlowToolName` and emit it in
  `buildStoryFlowToolPlan()` for every run (after `plan_visual_anchors`, before
  media work, so it can condition on the hero anchor). In `runGenerationJob`,
  invoke it as a **non-blocking item** alongside/within the media stage:
  poster failure logs the action as `failed` and never fails the run.
- **Done when:** a plain prompt-only run ends with a poster selected and
  visible on the project card with zero user input; a re-run with an unchanged
  brief does not spend an image generation.

### PR P3 — poster UX affordances *(after P1, parallel with P2)*

- **Files:** `apps/web/src/routes/DashboardCollectionsPage.tsx`, storyboard
  header component, `apps/web/src/lib/api-client.ts`.
- **Work:** "Regenerate poster" action (calls `/poster/generate` with
  `force: true`); "Use as poster" on any ready image asset (calls the existing
  pin endpoint via `v1Api.setProjectPoster`).
- **Done when:** a user can swap and regenerate posters from the UI, and a
  manual pick survives subsequent runs.

## Dependency graph

```
P1 (tool + endpoint) ──→ P2 (run wiring)
        └──────────────→ P3 (UX)          P2 ∥ P3
```

## Risks / decisions

- **Cost:** one portrait image per run, fingerprint-gated — re-runs are free
  unless the brief/anchor actually changed.
- **Text on posters:** deliberately out of scope; key art only. Title
  typography belongs to a render/overlay step (Remotion text layer), tracked
  in the watch/export scope.
- **Stage vs item:** this scope intentionally does **not** add a
  `GenerationStageType` for posters — it rides as an item so the progress UI
  contract stays stable. Revisit only if users need poster-level gates.
- **Relationship to** `docs/scopes/generation-engine-media-stages-prs.md`:
  P2 lands in the same `runGenerationJob` seams as the media stages (G2+);
  coordinate merge order, but P1/P3 have no overlap.
