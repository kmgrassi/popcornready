# Studio dashboard redesign — guided stepwise video creation (PR plan)

## Goal

Turn the Studio dashboard from a dense "developer control panel" into a **calm,
guided, step-by-step AI video studio**. The user sees only the controls for the
current step; advanced options are progressively revealed; empty states explain
what happens next; the timeline appears only once a rough cut exists.

Target experience: a new user understands the first action within 5 seconds, the
first screen shows fewer than 5 editable controls, and one strong popcorn-yellow
CTA dominates.

## Current state (what exists today)

Two separate surfaces implement pieces of this flow — the redesign **unifies them**:

- **`apps/web/src/routes/StudioPage.tsx`** → **`components/Editor.tsx`** (`:54-372`) — the
  dense **3-column** editor: left = `BriefPanel` (goal, length, aspect, style, audience, hook,
  payoff, caveat) + `AssetGenerationPanel` + `CharacterPanel`; center = `PreviewPanel` (black
  rectangle) + created-videos gallery; right = `SidebarPanel` (timeline, always rendered with a
  permanent "Generate a cut to see the timeline" empty state). **Generation handlers are stubbed**
  ("unavailable until the v1 generation route is mounted", `Editor.tsx:221-251`).
- **`apps/web/src/routes/NewProjectPage.tsx`** (`:57-498`) — a **4-step create wizard** (Upload →
  Describe → Format → Generate) that already does progressive disclosure (`<details>` advanced
  panels, review-gate checkboxes) and submits via `v1Api.createProject` + `startPromptGenerationRun`,
  then navigates to the run-progress page.
- **`apps/web/src/routes/RunProgressPage.tsx`** → **`components/progress/ProgressView.tsx`** — polls
  the run and renders a status banner, a vertical `StageRail`, per-item cards, and the review-gate
  card (Approve / Reject / Cancel).
- **Sidebar:** `components/AppLayout.tsx` (`AuthenticatedAppLayout`, `:92-261`) — nav = Home,
  Projects, Runs, Assets, Outputs; "New video" button + `ThemeToggle` (Popcorn Ready / Accent /
  Warm / Night) in the footer.
- **Styling:** global CSS (`styles/tokens.css`, `globals.css`, `studio-secondary.css`) + per-component
  CSS Modules. Tokens already define a 4px spacing scale (`--space-1..8`), radii, type scale
  (`--text-*`, `--title-*`), and per-theme color vars (`--bg`, `--panel`, `--accent`, …). Themes
  switch via `data-theme` on `<html>`.
- **Types:** `packages/shared/src/v1/types.ts` — `GenerationRun`, `GenerationStage`,
  `GenerationStageType`, `GENERATION_STAGE_LABELS`, `GATEABLE_GENERATION_STAGE_TYPES`,
  `VideoBriefInput`, `StoryContext`.

## Central architectural decision (SETTLED)

**Studio becomes a single guided wizard — clean break, no legacy.** The old dense 3-column
`Editor.tsx` workflow is poor and is **deleted outright**, not preserved behind a flag or kept as a
fallback. The 6 redesign steps span creation (Brief → Generate) *and* review/export (Review →
Export) and live on one stateful wizard page. The existing `NewProjectPage` 4-step wizard is the
**UX model** to extend (it already does steppered progressive disclosure well) — its logic is lifted
into Studio and the standalone route is retired.

- **`/studio` owns the full flow.** A `StudioShell` drives a 3-state machine
  (`initial` → `generating` → `review`) and renders the active step only, wizard-style.
- **Delete `components/Editor.tsx`** and its dense panels once their still-useful pieces (preview
  player, timeline rendering) are re-homed under `components/studio/`. No compatibility shim, no
  "classic editor" toggle.
- **Retire `NewProjectPage`.** Lift its create+startRun logic (`createProject`,
  `startPromptGenerationRun`, file upload, review-gate config) into the Studio **Generate** step via
  a shared `lib/startRun.ts`; delete the route. `/projects/new`, the sidebar "New video" button, and
  Home CTAs all route to `/studio`.
- **`RunProgressPage` stays** only as the deep-link/refresh-recovery view for an in-flight run, and it
  **shares** the polling + stage components used inside Studio's `generating`/`review` states (one
  implementation, not two).

## Characters & visual consistency (decided — out of the wizard)

There is **no manual character step** in the wizard. Per direction, character/asset consistency is
**agent-decided, not a user form**: all text generation runs first (brief → creative plan / story),
then the model decides whether a recurring character or setting needs a consistency **anchor**, and
**if so the anchor is established before any image/video generation**. This is how the pipeline
*should* work (it matches `docs/NORTH_STAR.md`).

Consequences for this redesign:

- **Cut the manual controls.** The old `components/editor/CharacterPanel.tsx`,
  `AssetGenerationPanel.tsx`, and `useCharacterLibrary.ts` are **deleted along with `Editor.tsx`** —
  they are not re-homed into a wizard step. The wizard never asks the user to manage a character
  library.
- **The capability is backend engine work, not a UI PR.** Today the v1 job executor
  (`runGenerationJob`) runs only `creative_plan → storyboard → timeline_assembly → quality_review`;
  **`asset_generation` is defined but never executed**, character anchors live in the legacy one-shot
  path + a separate on-demand endpoint, and the agent's `characterIds` signal is ignored by the run.
  Making "text → conditional anchor → visuals" real means: implement the `asset_generation` stage,
  wire the plan's character decision into an anchor-creation step ordered before keyframes, and feed
  character invariants into keyframe/clip prompts. **This belongs in the generation-engine scope**
  (alongside `docs/scopes/stepwise-story-generation-prs.md` and the `plan_visual_anchors` story-flow
  tool), and is tracked there — **not** in a Studio-redesign PR.
- **UI touch-point only:** PR 4's status checklist must be able to surface a *conditional*
  "Establishing character consistency" item when the engine runs an anchor stage (it simply renders
  whatever stages/items the run reports — no character-specific UI beyond that).

## Relationship to the backend stepwise scope

**Step 5 (Review & Edit) depends on `docs/scopes/stepwise-story-generation-prs.md`** (resumable
engine, resume wiring, the `review_feedback` channel, the feedback box). This doc is the **frontend**
redesign; it does not re-scope that work. Specifically, the **feedback textarea** in PR 6 here is the
same UI surface as **Workstream D** there — build it once, in the shared review components, and have
both plans point at it. Until the backend resume lands, PR 6's regenerate/approve buttons wire to the
existing endpoints and degrade gracefully (state updates, no live re-run).

---

## Shared contracts (agree before parallel work)

These seams let the PRs build independently against stubs.

- **Studio state machine** (`components/studio/useStudioFlow.ts`):
  ```ts
  type StudioState = 'initial' | 'generating' | 'review'
  type StudioStep  = 'brief' | 'footage' | 'story' | 'generate' | 'review' | 'export'
  interface StudioFlow {
    state: StudioState
    step: StudioStep            // active step (drives the stepper highlight)
    brief: BriefDraft           // accumulated form state across steps
    run?: GenerationRun         // present once generation starts
    goTo(step): void
    startGeneration(): Promise<void>   // create project + start run -> state='generating'
  }
  ```
  `BriefDraft` is the superset of every step's fields (goal, lengthSec, aspectRatio, footageChoice,
  + advanced: audience, platform, format, hook, bestVisual, bigIdea, payoff, accuracyNote, style).
- **Step component contract** — every step is a self-contained component:
  `({ draft, update, next, back }: StepProps) => JSX`. Steps never reach into siblings; they only
  read/patch `draft` and call `next()`/`back()`. This is what makes steps parallelizable.
- **Timeline visibility invariant** — the timeline panel renders **only** when
  `flow.state === 'review'` and a timeline artifact exists. There is no permanent empty timeline panel.
- **Design tokens** — new/adjusted tokens (PR 0) are the styling contract: a single CTA token
  (`--cta` popcorn-yellow), step/heading type tokens, and an 8/12/16 section-spacing convention.
  Every other PR consumes these vars, never hard-coded colors/sizes.
- **Generation status mapping** — the calm checklist maps `GenerationStageType` →
  human steps: `creative_plan`→"Planning story structure", `storyboard`/`asset_generation`→
  "Selecting clips", `timeline_assembly`→"Building timeline", `quality_review`/`export`→
  "Generating preview", `ready`→"Ready for review". One shared map in
  `components/studio/statusChecklist.ts`.

---

## PRs

### PR 0 — Design system: tokens + Studio UI kit *(foundation; everyone depends on it)*
The shared visual + component contract. Land first.
- **Files:** `styles/tokens.css` (add `--cta`/`--cta-contrast` popcorn-yellow CTA token; larger
  page-title/step-heading type tokens, e.g. `--title-xl`; codify an 8/12/16 section-spacing
  convention; soften borders toward `--panel-2`, reduce brown-on-brown by lifting `--text`/`--muted`
  contrast per theme in `globals.css`); new primitives under `components/ui/`:
  `Card.tsx`, `Stepper.tsx`, `Disclosure.tsx` (collapsed-by-default advanced panel),
  `EmptyState.tsx`, `StatusChecklist.tsx`, each with a `.module.css`. Extend existing `Button` with a
  prominent `cta` variant.
- **Done when:** Storybook-less smoke page or the existing pages render with the new tokens; primitives
  exported and visually match the "guided studio" direction (larger cards, subtle borders, one yellow CTA).
- **Acceptance criteria served:** visual hierarchy, contrast/spacing, consistent spacing scale, one CTA.

### PR 1 — Studio shell: state machine + stepper + empty state *(backbone; steps plug in)*
- **Files:** `routes/StudioPage.tsx` (rewrite to render `StudioShell`), new
  `components/studio/StudioShell.tsx`, `useStudioFlow.ts`, `StudioEmptyState.tsx`; **extract the
  helpers out of `NewProjectPage` first** — `lib/startRun.ts` (`createProject` +
  `startPromptGenerationRun`) and `lib/upload.ts` (file-upload logic) — **then** delete
  `NewProjectPage.tsx`; route updates in `App.tsx` (point `/projects/new` + sidebar "New video" at
  `/studio`).
- **Work:** implement the `initial|generating|review` machine and the 6-step `Stepper` (renders the
  active step's component only). Initial empty state: headline "Create your first AI rough cut",
  support text "Start with a brief, add footage, then review an editable timeline.", primary CTA
  "Start new video". Big high-contrast "Start new video" CTA near the top of Studio.
- **Why the extraction lives here:** PR 1 is the PR that deletes `NewProjectPage`, so it must also
  lift `startRun.ts`/`upload.ts` in the same change — that keeps the only working create/run wiring
  alive with no cross-PR ordering hazard. PR 3 (upload) and PR 4 (generate) then *consume* these
  helpers; they do not re-extract them.
- **Done when:** `/studio` with no active project shows the empty state + CTA; clicking it enters the
  Brief step; the stepper shows all 6 steps with only the active one's controls visible; `startRun.ts`
  and `upload.ts` exist and `NewProjectPage` is gone with no lost functionality.
- **Acceptance:** first action obvious in 5s; main CTA visually obvious; empty state explains next steps.

### PR 2 — Step 1 Brief (simplified) + progressive disclosure
- **Files:** `components/studio/steps/BriefStep.tsx`, `components/studio/AdvancedDirection.tsx`
  (uses PR 0 `Disclosure`), copy map `components/studio/copy.ts`.
- **Work:** Brief step shows **only**: "What should this video do?" textarea; length 30s/60s/2m/5m;
  aspect 9:16/16:9/1:1; primary CTA "Continue" — **< 5 controls**. Everything else goes under
  **"Advanced creative direction"** (collapsed): audience, platform, story format, hook question,
  best visual proof, one big idea, payoff, accuracy note, style. Apply the friendlier labels (item 9):
  "Creative goal/script"→"What should this video do?", "Strongest visual"→"Best visual proof",
  "Payoff"→"What should the viewer understand by the end?", "Caveat/trust note"→"Accuracy note",
  "Uploaded-footage mode"→"How should we use your footage?".
- **Done when:** Brief step has <5 visible controls; advanced panel is collapsed by default and holds
  all optional fields; labels match the copy map.
- **Acceptance:** <5 first-screen controls; advanced collapsed by default; plain labels.

### PR 3 — Step 2 Source Footage + Step 3 Story Direction
- **Files:** `components/studio/steps/SourceFootageStep.tsx`, `steps/StoryDirectionStep.tsx`; consume
  `lib/upload.ts` (extracted in PR 1) — do not re-extract from `NewProjectPage`, which PR 1 has deleted.
- **Work:** Footage step = "How should we use your footage?" (upload vs. prompt-only vs.
  uploaded-footage-edit mode). Story Direction step surfaces the few creative knobs worth a dedicated
  step (format + hook), leaving the long tail in Brief's advanced panel. Both follow the step contract.
- **Done when:** footage choice and story direction are their own calm steps; skipping footage
  (prompt-only) is one obvious click.

### PR 4 — Step 4 Generate + generation status checklist *(consumes the create flow)*
- **Files:** `components/studio/steps/GenerateStep.tsx`, `components/studio/GenerationChecklist.tsx`,
  `components/studio/statusChecklist.ts`; consume the shared create helper `lib/startRun.ts`
  (extracted in PR 1 — `createProject` + `startPromptGenerationRun`), do not re-extract it.
- **Work:** "Generate rough cut" CTA → `flow.startGeneration()` → state `generating`. Replace the step
  controls with a **clean progress checklist**: Planning story structure → Selecting clips → Building
  timeline → Generating preview → Ready for review, driven by polling `getGenerationRun` (reuse the
  `RunProgressPage` poll cadence/visibility logic). Review-gate config (which stages pause) lives in an
  advanced disclosure here.
- **Done when:** clicking Generate swaps the setup card for the checklist; stages tick green as the run
  progresses; reaching a gate/terminal transitions to `review`.
- **Note:** the checklist is data-driven — it renders whatever stages/items the run reports, so when
  the engine later runs a conditional character-anchor stage it surfaces as an "Establishing
  character consistency" item with no character-specific UI work here.
- **Acceptance:** generation status is a calm checklist; reinforces agent-driven stepwise feel.

### PR 5 — Preview area redesign *(independent)*
- **Files:** `components/editor/PreviewPanel.tsx`, new `components/studio/PreviewPlaceholder.tsx` +
  `.module.css`.
- **Work:** Before generation, replace the black rectangle with a polished placeholder: subtle
  film-frame border, center video-card icon, "Your rough cut will appear here", secondary "Generate a
  video to preview timing, pacing, and edits." During generation, a loading/preview state. After, the
  existing `PreviewPlayer`.
- **Done when:** no black void in `initial`/`generating`; placeholder reads as intentional; player
  appears only when a cut exists.
- **Acceptance:** empty preview explains what will appear.

### PR 6 — Step 5 Review & Edit: conditional timeline + feedback *(depends on PR 1; coordinates with backend scope)*
- **Files:** rework `components/editor/SidebarPanel.tsx` into `components/studio/TimelinePanel.tsx`
  (real clips/scenes/durations/editable segments); `components/studio/ReviewStep.tsx` (scene notes,
  regenerate options, export CTA); the **feedback textarea** shared with Workstream D of
  `stepwise-story-generation-prs.md` (`components/progress/ProgressView.tsx` review card).
- **Work:** Timeline panel renders **only** in `review` state once a timeline exists — delete the
  permanent "Generate a cut to see the timeline" empty panel. Review layout = center video preview +
  right timeline/editor + side/bottom scene notes & regenerate/export. Wire regenerate/approve to the
  existing run endpoints (live re-run arrives with the backend scope).
- **Done when:** Studio shows no timeline until a rough cut exists; in `review` the timeline shows real
  editable segments; feedback box posts a note.
- **Acceptance:** no timeline until a timeline exists; review state reveals timeline + editing only when relevant.

### PR 7 — Step 6 Export
- **Files:** `components/studio/steps/ExportStep.tsx`; wire to the export endpoint (currently stubbed in
  `Editor.tsx:221-251` — coordinate with whoever mounts the v1 export route).
- **Work:** Export step = format/caption options + one clear "Export" CTA; success state links to the
  output in the Outputs view.
- **Done when:** export is a discrete final step with an obvious CTA and a clear done state.

### PR 9 — API: workspace list routes for the redesigned nav *(precondition for PR 8)*
The backend is otherwise **ready** — the routes the old `Editor.tsx` claims are "not mounted" are in
fact mounted and working (`generation-entrypoints/prompt`, `generation-runs/:runId` + approve/reject/
cancel, `timelines` assemble/critique/`:timelineId/revisions`/`:timelineId/exports`, assets, beats).
The only genuine API gaps the redesign hits:
- **Files:** `apps/api/src/routes/v1/workspaces.ts` (today mounts only `/workspaces/:id/assets`).
- **Work:** add the two cross-project list endpoints the web client already calls but the API lacks:
  - `GET /api/v1/workspaces/:workspaceId/generation-runs` → backs `v1Api.listWorkspaceGenerationRuns()`
    (api-client `:340`) — the Projects/Runs view.
  - `GET /api/v1/workspaces/:workspaceId/outputs` → backs `v1Api.listWorkspaceOutputs()`
    (api-client `:377`) — the Outputs view where Created Videos relocate.
  - Both are RLS-scoped reads aggregating across the workspace's projects (mirror the existing
    `/workspaces/:id/assets` handler shape).
- **Out of scope (decide, don't build for the redesign):** audio alignment (no route exists; the
  6-step wizard doesn't surface it — leave unbuilt), `generation-runs/:runId/retry` 501 (regenerate
  uses approve/reject, which work), `generation-entrypoints/revisions` 501 (superseded by the working
  `timelines/:timelineId/revisions`).
- **Done when:** Outputs and Projects/Runs views load real cross-project data instead of 404ing.

### PR 8 — Sidebar simplification + library relocation *(independent; needs PR 9 for live data)*
- **Files:** `components/AppLayout.tsx`, `components/AppLayout.module.css`, `components/ThemeToggle.tsx`.
- **Work:** Sidebar nav = Home, Studio, Projects, Assets, Outputs, Settings/Admin; clear active-section
  highlight; quieter workspace selector. Move the theme buttons out of the footer into a Settings menu
  (or gate them dev-only). Remove the "Created Videos" gallery from the Studio page (`Editor.tsx`
  center column) — surface created videos in **Outputs/Projects** (the existing
  `DashboardCollectionsPage` `OutputsPage`) and/or a collapsed "Recent" strip below the Studio
  workflow, so the library never competes with the active creation task.
- **Done when:** sidebar is quieter with a clear active state; theme switcher lives behind settings;
  Studio prioritizes the single active video; created videos live in Outputs.
- **Acceptance:** creation/library hierarchy is clear; sidebar noise reduced.

---

## Dependency graph & merge order

```
PR 0 (tokens + UI kit) ──┬─► PR 1 (shell) ──┬─► PR 2 (Brief)
                         │                  ├─► PR 3 (Footage + Story)
                         │                  ├─► PR 4 (Generate + checklist)
                         │                  ├─► PR 6 (Review + timeline)  ◄── backend stepwise scope
                         │                  └─► PR 7 (Export)
                         ├─► PR 5 (Preview)   (independent)
                         └─► PR 8 (Sidebar + library)  ◄── PR 9 (API workspace routes)

PR 9 (API: workspace list routes) ── independent, backend-only, start anytime
```

- **Land first:** PR 0 (everything consumes the tokens/kit), then PR 1 (the shell other steps plug into).
- **Fully parallel after PR 1:** PR 2, 3, 4, 6, 7 (each is a distinct step component implementing the
  step contract). PR 5 and PR 8 can start immediately alongside PR 0/1 (different files). PR 9 is
  backend-only (different package, `apps/api`) and can land any time — PR 8's Outputs/Projects views
  show live data once it merges.
- **Cross-plan coordination:** PR 6 shares the feedback box with Workstream D of
  `stepwise-story-generation-prs.md` — assign them to the same person or build the component first in
  whichever lands sooner.

## Merge hotspots

- `routes/StudioPage.tsx` / `components/Editor.tsx` — PR 1 rewrites `StudioPage` and **deletes
  `Editor.tsx`** (after PR 5 re-homes the preview and PR 6 re-homes the timeline). PRs 2–7 add *new*
  step files under `components/studio/` rather than editing `Editor.tsx`, so the deletion is clean.
- `components/AppLayout.tsx` — PR 1 (route targets for "New video") and PR 8 (nav items) both touch it;
  sequence PR 1 → PR 8 or split the file's nav array into its own module.
- `styles/tokens.css` / `globals.css` — only PR 0 edits tokens; other PRs add component `.module.css`.
- `NewProjectPage.tsx` — **PR 1 owns the whole lifecycle**: it extracts `lib/startRun.ts` +
  `lib/upload.ts` *and* deletes the route in the same PR, so the working create/run wiring is never
  orphaned. PR 3 and PR 4 only *consume* those helpers — no extraction, no ordering hazard. (Earlier
  drafts split the extraction into PR 4; that's wrong because PR 1 lands first and would delete the
  source — keep extraction and deletion together in PR 1.)

## Risks / decisions

- **Clean break, no legacy** (settled): `Editor.tsx` and `NewProjectPage.tsx` are deleted, not gated
  behind a flag. The only sequencing care is re-homing the still-useful pieces (preview, timeline,
  create helper) before the deletions land — captured in the merge order.
- **The Editor's "route not mounted" stubs are stale, not real gaps.** `Editor.tsx`'s generate/
  revise/export/asset handlers (`:217-251`) throw "unavailable until the v1 … route is mounted", but
  those v1 routes **are** mounted and working. Because PR 1 deletes `Editor.tsx` and the new steps
  call the real `v1Api` methods, this resolves itself — the steps wire to live endpoints, not stubs.
  The only true backend work is **PR 9** (two missing `/workspaces/:id/{generation-runs,outputs}`
  list routes). Audio alignment has no route and isn't surfaced by the wizard — leave it unbuilt.
- **Theme buttons**: confirm whether Accent/Warm/Night are user-facing or dev-only. If dev-only, gate
  behind a settings/admin flag rather than the sidebar (item 6).
- **Scope dial:** a first milestone of PR 0 + PR 1 + PR 2 + PR 5 + PR 8 already delivers the calmer,
  guided *initial* experience (empty state, simplified brief, polished preview, quiet sidebar, no
  stray timeline) and satisfies most acceptance criteria; PRs 3/4/6/7 complete the full stepper.

## Acceptance criteria → where satisfied

| Criterion | PR(s) |
|---|---|
| New user understands first action in 5s | PR 1 (empty state + CTA) |
| Studio shows no timeline until one exists | PR 1 (state machine), PR 6 (conditional panel) |
| First screen < 5 editable controls | PR 2 (Brief) |
| Advanced settings collapsed by default | PR 0 (`Disclosure`), PR 2 |
| Main CTA visually obvious | PR 0 (`--cta`), PR 1 |
| Empty states explain next steps | PR 1, PR 5 |
| Timeline/editing revealed only when relevant | PR 6 |
| Calm generation status | PR 4 (checklist) |
| Library doesn't compete with creation | PR 8 |
