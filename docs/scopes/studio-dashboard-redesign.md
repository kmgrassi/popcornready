# Studio Dashboard Redesign — Scope

## Objective

Make the Studio feel like a **calm, product-led creative workspace** instead of a
dense settings panel. Today `/studio` drops the user straight into a three-column
form (upload + asset generation + brief + story context on the left, preview in
the middle, timeline/revisions on the right) — every field exposed before they've
started anything. We replace that first impression with a **clean dashboard + one
obvious "New Project" CTA**, and push the configuration into a focused creation
flow and an in-editor inspector.

**The core move:** split the single `/studio` Editor into two states —

- **StudioHome** — the welcoming dashboard: sidebar, hero CTA, recent-project
  cards, empty state. *Default after login.*
- **ProjectEditor** — the detailed workspace (preview, timeline, advanced
  controls), shown only when a project is open.

Keep the dark/warm cinematic Popcorn Ready identity; reduce visual noise; hide
advanced inputs until needed.

## Current state (what we're refactoring)

The app is the **Vite SPA at `apps/web`** (React Router). Relevant files:

| Piece | Path | Role |
|---|---|---|
| Studio route | `apps/web/src/routes/StudioPage.tsx` | thin wrapper → `<Editor/>` |
| Editor (the dense screen) | `apps/web/src/components/Editor.tsx` | 3-col `grid-template-columns: 340px 1fr 380px` |
| Form panels | `apps/web/src/components/editor/{BriefPanel,AssetGenerationPanel,CharacterPanel,LibraryPanel}.tsx` | the up-front fields to hide |
| Preview / timeline | `apps/web/src/components/editor/{PreviewPanel,SidebarPanel}.tsx` | the editor surface |
| App shell / nav | `apps/web/src/components/AppLayout.tsx` | **top-bar** nav (Home, How it works, Pricing, Studio, Auth, Theme) — **no sidebar** |
| New-project entry (legacy) | `apps/web/src/components/PromptComposer.tsx` | goal box + cog → **legacy** `POST /api/oneshot` (Next route `src/app/api/oneshot/route.ts`, returns `id: "default"`) — **does not exist in Express / the V1 run model** |
| V1 generation API | `apps/api/src/routes/v1/generation-entrypoints.ts` + `…/generation-runs` | the real entrypoints the SPA must drive (§3.1) |
| Projects + run API client | `apps/web/src/lib/api-client.ts` | has `createProject`, `getProject`, `getGenerationRun`, `updateGenerationRun` — **no "start run" method yet** |
| Design tokens | `apps/web/src/styles/{tokens,base,globals}.css` | `--bg/--panel/--panel-2/--border/--accent/--muted…` + 4 themes |

Form fields currently surfaced up-front (the density to remove): footage upload +
description; character management; asset generation (provider, kind, prompt, size,
seconds, consistency mode); brief (goal, length, aspect, style, edit-mode); story
context (audience, platform, format, hook, strongest visual, one big idea); plus
preview/export and timeline/critic/revisions.

## Alignment with `dashboard-ui.md` (read before building)

[docs/scopes/dashboard-ui.md](./dashboard-ui.md) already plans the authenticated
app shell — a persistent nav + routes `/dashboard`, `/projects`, `/runs`,
`/assets`, `/outputs` and workspace-scoped summary APIs. **This redesign must not
spawn a second, competing shell.** Decision: **this scope delivers the nav shell
(the left sidebar) and the Studio home + New Project flow + editor cleanup; the
broader cross-project pages (`/runs`, full `/assets`, `/outputs`) remain
`dashboard-ui.md`'s deliverables**, mounted into the *same* sidebar.

Sidebar reconciliation — the requested set (Studio, Projects, Uploads, Templates,
Brand Kit, Settings) vs. dashboard-ui's (Dashboard, Projects, Runs, Assets,
Outputs). Proposed **canonical sidebar** (one shell, superset):

| Item | Route | Notes |
|---|---|---|
| **Studio** | `/studio` | StudioHome — the post-login dashboard (replaces dashboard-ui's "Dashboard") |
| **Projects** | `/projects` | all projects (dashboard-ui) |
| **Uploads** | `/uploads` | user-uploaded footage library (≈ dashboard-ui `/assets`, scoped to uploads) |
| **Templates** | `/templates` | new — start-from-template gallery |
| **Brand Kit** | `/brand` | new — logos, fonts, colors, defaults |
| **Settings** | `/settings` | account/workspace |

`Runs` and `Outputs` from dashboard-ui fold in as **sub-views** (a tab inside a
project / a filter on Projects) rather than top-level rail items — flagged as an
open decision (§9). Account/workspace controls live in a slim **top bar** above
the main content, not in the rail.

---

## 1. Navigation — the left sidebar (`StudioSidebar`)

A persistent, narrow (~220px), quiet left rail for all authenticated app routes:

- Popcorn Ready **logo** at top (`LogoMark`, links to `/studio`).
- The six canonical items above, each with a minimal icon + label.
- **Clear active state** (accent text/indicator on the current route; subtle
  `--accent-soft` background), hover state, generous vertical rhythm.
- Collapses to icon-only / a drawer on narrow widths.

Replaces the marketing-style top-bar nav for authed routes (the public landing
keeps its own `lp-nav`). A slim **top bar** in the content area carries account
menu + `ThemeToggle` (the theme switcher already moved off the landing nav).

---

## 2. StudioHome (the new default)

The calm first screen. Vertical stack, lots of padding, few borders:

1. **Hero card**
   - Heading: **"Create your next cut"**
   - Subheading: "Upload clips, describe the goal, and let Popcorn Ready build the
     first edit."
   - **Primary CTA: "New Project"** — the single most prominent action (large,
     accent-filled, unmistakable).
2. **Recent Projects** grid of `ProjectCard`s (§4). If none →
   **empty state**: "Your projects will appear here once you create your first
   cut." (with the CTA repeated).
3. **Optional** "Start from a template" strip (small, secondary) — reuses the
   existing template carousel content from `PromptComposer`.

No preview/timeline on this screen — those belong to ProjectEditor only.

---

## 3. New Project flow (progressive, not all-at-once)

Clicking **New Project** opens a focused flow (recommend a **full-page route
`/projects/new`** for room + deep-linking; a modal/drawer is an acceptable
alternative — §9). Four steps, with **"Advanced options" collapsed** at each:

| Step | Asks | Reuses |
|---|---|---|
| 1 · Upload footage | drag/drop clips (optional — prompt-only is allowed) | existing upload input + `LibraryPanel` logic |
| 2 · Describe the goal | project name + creative goal/brief | `BriefPanel` goal field; `PromptComposer` textarea |
| 3 · Choose format / platform | aspect/length + platform/format presets | `BriefPanel` aspect/length; story-context platform/format |
| 4 · Generate rough cut | confirm → kick off generation → ProjectEditor | V1 run model: `createProject` + generation-entrypoint → `runId` (§3.1) — **not** `/api/oneshot` |

**Advanced options** (collapsed) absorb today's dense fields: asset-generation
provider/kind/size/consistency, review gates, full story context (audience, hook,
strongest visual, one big idea), style, edit-mode. On **Generate**, create the
project + run and route into ProjectEditor (showing `RunProgress` until ready).

Essentials visible by default across the flow: **project name, upload, creative
goal, Generate** — everything else under presets/advanced.

### 3.1 Generation wiring — the V1 run model, not `/api/oneshot`

`/api/oneshot` is the **legacy Next monolith** route
(`src/app/api/oneshot/route.ts`, returns a hard-coded `id: "default"`) and does
**not** exist in the Express API. Reusing it from the SPA would 404 (or bypass the
run model and yield no `runId` to route into ProjectEditor). The New Project flow
must drive the **V1 run model** — which is also exactly what `RunProgress` polls.
On **Generate**:

1. `POST /api/v1/projects` — create the project (api-client `createProject`) → `projectId`.
2. Start a run via the matching **generation entrypoint**
   (`apps/api/src/routes/v1/generation-entrypoints.ts`):
   - clips uploaded → `POST …/projects/:projectId/generation-entrypoints/uploaded-footage`
   - prompt-only → `POST …/projects/:projectId/generation-entrypoints/prompt`

   → returns a **`runId`**.
3. Route to `/projects/:projectId/runs/:runId` → `RunProgress` polls
   `GET …/generation-runs/:runId` (`getGenerationRun`) and honors review gates via
   `updateGenerationRun` (approve/reject/cancel) → on completion, hand off to
   **ProjectEditor**.

**api-client gap (PR 4 must close it):** `api-client.ts` today has
`createProject` / `getProject` / `getGenerationRun` / `updateGenerationRun` but
**no method to start a run** — PR 4 adds the entrypoint call. The collapsed
**Advanced options** (review gates, story context, provider, aspect/length/style)
become the **entrypoint request body**, not `oneshot` params.

---

## 4. Project cards + status

`ProjectCard` (new component) shows: thumbnail/placeholder preview, **title**,
**last edited** time, **status badge**, and quick actions **Open / Duplicate /
Delete**.

Data gaps to close (today `V1Project` is `{id, name, status: 'active'|'deleted',
createdAt, updatedAt, …}` — no thumbnail, and status doesn't model
draft/rendering/ready):

- **Display status** `Draft | Rendering | Ready` is **derived** from the project's
  latest generation run (no run/plan → Draft; run in progress → Rendering;
  completed export → Ready). Compute server-side in the projects list response or
  client-side from runs — §9.
- **Thumbnail**: use a placeholder initially; later, the first beat keyframe or an
  export frame. Not blocking.
- **Quick actions** need `POST /api/v1/projects/:id/duplicate` and
  `DELETE /api/v1/projects/:id` (soft-delete → `status: 'deleted'`, which exists).

---

## 5. ProjectEditor (the detailed workspace)

The existing `Editor.tsx` three-column layout becomes **ProjectEditor**, shown
only when a project is open (`/projects/:id` or `/studio/projects/:id`). Cleanups:

- Preview + timeline are the **dominant surface**; the dense left form is **not**
  always-on.
- Move advanced/dense inputs (`AssetGenerationPanel`, `CharacterPanel`, full story
  context) into a **collapsible inspector** panel (right side), opened on demand —
  not the default state.
- Keep only essentials immediately reachable; surface the rest progressively.

The empty preview/timeline must **not** be the dominant default app state — that's
StudioHome's job now.

---

## 6. Visual cleanup (applies across shell + home + editor)

Concrete, using existing tokens:

- **More padding** around sections (e.g. 24–32px), generous whitespace.
- **Fewer bordered boxes** — prefer `--panel`/`--panel-2` background shifts over
  1px `--border` outlines; **softer dividers** (lower-contrast hairlines).
- **Clear active nav state**; consistent hover/focus.
- **Larger section headings**; stronger type hierarchy.
- **Consistent button styling** — one primary (accent-filled) / secondary
  (outline/ghost) system; the "New Project" CTA is the canonical primary.
- **Avoid long text inputs visible by default** — collapse into the New Project
  flow / inspector.

Keep all four themes (popcorn-ready/popcorn/popcorn-warm/popcorn-night) working.

---

## 7. Component refactor map

| New / changed | From | Notes |
|---|---|---|
| `StudioSidebar` (new) | — | the left rail, active state |
| `AppShell` (refactor `AppLayout`) | `AppLayout.tsx` | sidebar + slim top bar + `<Outlet/>` for authed routes |
| `StudioHome` (new) | — | hero + CTA + recent projects + empty state |
| `ProjectCard` (new) | — | card + status badge + quick actions |
| `NewProjectFlow` (new) | `PromptComposer` + `BriefPanel` fields | the 4-step wizard; advanced collapsed |
| `ProjectEditor` (rename/refactor) | `Editor.tsx` | 3-col → calmer; inspector for advanced |
| `EditorInspector` (new) | `AssetGenerationPanel`, `CharacterPanel`, story context | collapsible, on-demand |
| route split | `StudioPage.tsx` | `/studio`→StudioHome, `/projects/:id`→ProjectEditor, `/projects/new`→flow |

---

## 8. PR breakdown

Sequenced so each PR is shippable and reviewable on its own; later PRs depend on
the shell from PR 1.

- **PR 1 — App shell + left sidebar.** Add `StudioSidebar`; refactor `AppLayout`
  into `AppShell` (rail + slim top bar with account menu + `ThemeToggle` +
  `<Outlet/>`). Wire the six canonical routes (stub pages for Templates/Brand
  Kit/Uploads/Settings where they don't exist yet). Active/hover states. **No
  editor behavior change.** Foundation for everything; coordinates with
  `dashboard-ui.md`'s shell.
- **PR 2 — StudioHome + route split.** New `/studio` → `StudioHome` (hero, "New
  Project" CTA, empty state). Move the current Editor to `/projects/:id` as
  `ProjectEditor`. `ProjectCard` + Recent Projects grid wired to
  `GET /api/v1/projects`. (Status/thumbnail can be placeholder until PR 3.)
- **PR 3 — Project status, thumbnails & card actions.** Derive `Draft | Rendering
  | Ready` from latest run; add `last edited`; thumbnail placeholder → first
  keyframe/export frame. Add `POST …/projects/:id/duplicate` +
  `DELETE …/projects/:id`; wire Open/Duplicate/Delete.
- **PR 4 — New Project flow.** `/projects/new` 4-step wizard (upload → describe →
  format → generate) with **Advanced options** collapsed; reuse `PromptComposer`'s
  goal/template UI + upload + brief fields. **Drive the V1 run model (§3.1), not
  `/api/oneshot`:** add a "start run" method to `api-client.ts` hitting the
  `prompt` / `uploaded-footage` generation-entrypoint, then route
  `createProject` → entrypoint → `/projects/:id/runs/:runId` (`RunProgress`) →
  ProjectEditor. *(Largest PR; can split into 4a wizard shell / 4b V1 generation
  wiring + advanced options.)*
- **PR 5 — ProjectEditor cleanup + inspector.** Calm the 3-col layout; move
  `AssetGenerationPanel` / `CharacterPanel` / full story context into a
  collapsible `EditorInspector`; preview+timeline dominant; essentials only by
  default.
- **PR 6 — Visual system pass.** Spacing, fewer borders, softer dividers, heading
  scale, button consistency, token tweaks across shell/home/editor. (A focused
  design-polish PR; some of this lands incrementally in 1–5, this is the
  consolidation/QA pass.)
- **PR 7 — (optional) Secondary pages.** Flesh out Templates, Brand Kit, Uploads
  beyond stubs (or hand to `dashboard-ui.md` for `/assets`/`/outputs`/`/runs`).

Dependencies: PR1 → (PR2 → PR3, PR4 → PR5) → PR6. PR7 independent after PR1.

---

## 9. Open decisions

- **New Project surface**: full page `/projects/new` (recommended — room +
  deep-linkable) vs. modal vs. drawer (§3).
- **Project route**: `/projects/:id` (aligns with dashboard-ui) vs.
  `/studio/projects/:id` (keeps everything under Studio) (§5).
- **Status derivation**: compute `Draft/Rendering/Ready` server-side in the
  projects list vs. client-side from runs (§4).
- **Runs & Outputs placement**: top-level rail items (dashboard-ui's model) vs.
  sub-views under a project / Projects filter (this scope's proposal) (§"Alignment").
- **Sidebar set**: confirm the canonical six (Studio/Projects/Uploads/Templates/
  Brand Kit/Settings) and the rename of dashboard-ui's "Dashboard"→"Studio",
  "Assets"→"Uploads".
- **Templates/Brand Kit depth**: real features now vs. stubbed nav targets that
  land empty states (PR 7).

_Resolved during scoping:_ split `/studio` into **StudioHome** (default) +
**ProjectEditor** (project open); one **left sidebar** shell shared with
`dashboard-ui.md` (this scope owns the shell + Studio home + New Project flow +
editor cleanup); advanced inputs hidden in the New Project flow + editor
inspector; reuse existing CSS tokens + 4 themes.
