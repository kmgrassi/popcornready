# Guided dashboard — one action at a time (PR plan)

## Goal

Extend the Studio wizard's "one step at a time" philosophy from `/studio` to the
**entire authenticated app**. Today the wizard is calm but the chrome around it
is not: the user lands on a placeholder Home, faces a sidebar with five
destinations plus a topnav with three more, and the config they might need is
scattered across pages instead of appearing where decisions are made.

Target experience:

- **At every moment the app proposes exactly one next action** — start a video,
  continue a draft, watch a running generation, review a finished cut. The user
  never has to decide *where to go* before deciding *what to do*.
- **Nothing is removed; everything is re-homed.** Every menu, page, and config
  option stays available, but is progressively disclosed: out of the way by
  default, reachable in ≤ 2 interactions from where it's relevant, and findable
  by name from anywhere via a command palette.
- The library, settings, and dev surfaces never compete with the creation flow
  for attention.

## Relationship to existing scopes (read before building)

- **[studio-redesign-prs.md](./studio-redesign-prs.md)** — the 6-step wizard
  inside `/studio`. Largely landed (PRs 0–2, 4, 5, 8 done; Footage/Story,
  Review, and Export steps are scaffolds). **This scope does not re-scope the
  wizard**; finishing those steps continues under that plan, in parallel.
  This scope owns everything *around* the wizard: Home, navigation, library,
  settings, findability, and flow continuity across sessions.
- **[dashboard-ui.md](./dashboard-ui.md)** — the workspace-scoped read API +
  collection views. The list endpoints and views exist
  (`apps/api/src/routes/v1/workspaces.ts:92` generation-runs, `:134` outputs,
  `:43` assets; `apps/web/src/routes/DashboardCollectionsPage.tsx`). The one
  unbuilt piece this scope needs is the **dashboard summary endpoint**
  (`GET /workspaces/:id/dashboard`) — PR 1 here delivers it to that doc's
  contract.
- **[studio-dashboard-redesign.md](./studio-dashboard-redesign.md)** — the
  earlier StudioHome/ProjectEditor split. **Superseded** where it conflicts
  with the wizard (there is no ProjectEditor; review/edit is a wizard state).
  Its sidebar-set proposal (Templates, Brand Kit, Uploads as top-level rail
  items) is also superseded by the navigation diet below.
- **[docs/NORTH_STAR.md](../NORTH_STAR.md)** — constraints this scope inherits:
  autonomous by default (gates opt-in, never forced friction), artifacts
  visible the instant they exist, propose-before-expensive-redo, nothing is
  throwaway. The guided Home must reflect a *running agent* model, not a
  static stats page.

## Current state (what makes it overwhelming)

- **Two navigation systems at once.** Sidebar `PRIMARY_NAV`
  (`apps/web/src/components/AppLayout.tsx:31`): Home, Studio, Projects,
  Assets, Outputs — plus a Settings/Admin footer and a "New video" CTA.
  Topnav `TOPNAV` (`AppLayout.tsx:39`): Studio (duplicate), Storyboard, Evals.
  Nine visible destinations before the user has typed anything.
- **Routed-but-orphaned surfaces.** `/uploads`, `/templates`, `/brand`,
  `/runs`, `/settings` (a `WorkspaceStubPage`) exist as routes
  (`apps/web/src/App.tsx:53-72`) — partly stubs, partly real — adding surface
  area without adding capability.
- **Home is a dead end.** `/dashboard` and `/projects` render
  `DashboardPlaceholderPage` (a headline + one CTA). The user's actual state —
  a half-finished brief, a run in flight, a cut awaiting review — is invisible
  at the moment they arrive.
- **The wizard forgets.** `useStudioFlow` state is in-memory only. Refresh
  mid-brief and the draft is gone; refresh mid-generation and recovery only
  works via the `RunProgressPage` deep link, not by returning to `/studio`.
  "One action at a time" breaks the moment the session does.
- **Config findability is page-shaped.** What config exists is reasonably
  placed (the Brief step's Advanced disclosure holds the long tail), but there
  is no way to *search* for an option, and the Settings page is a stub.

## The disclosure ladder (central design contract)

Every piece of UI is assigned a level. This is the contract all PRs build to —
it's how "all config stays available" and "one action at a time" coexist.

| Level | What lives here | Surface |
|---|---|---|
| **L0** | The one primary action for the current state | Home hero card / step CTA |
| **L1** | The active step's essential controls (< 5) | Wizard step body |
| **L2** | Optional config for the current decision | Collapsed `Disclosure` inside the step (exists today: Advanced creative direction, review gates) |
| **L3** | Secondary destinations — browse, manage, configure | Library, Settings — one click from the sidebar, never in the creation path |
| **L4** | Everything, by name | Command palette (⌘K): every route, action, and setting indexed and searchable |

Rules:

1. **One L0 per screen.** If two actions compete, one of them is L3.
2. **Config lives where the decision is made.** Generation options belong to
   the wizard step that uses them (L2), not a global settings page. Settings
   (L3) holds only cross-project defaults and account/workspace concerns.
3. **≤ 2 interactions from relevance.** Any option must be reachable in at
   most two clicks from the screen where it matters (e.g. open disclosure →
   field).
4. **The palette is the findability guarantee.** Demoting something down the
   ladder is only allowed if it's registered in the palette. "Out of the way"
   must never become "lost."
5. **Nothing is deleted from the product by this scope** — only re-homed.
   (Code, by contrast, gets clean breaks: placeholders and dead nav are
   deleted outright, per repo convention — no legacy shims.)

## Central decisions

### 1. Home becomes a state-aware launchpad, not a stats dashboard

`/dashboard` stops being a placeholder (and never becomes a wall of counts).
It renders **one hero card derived from workspace state**, plus a quiet
recent-outputs strip:

| Workspace state | Hero (L0) |
|---|---|
| No projects yet | "Create your first AI rough cut" → `/studio` |
| Draft(s) in progress | "Continue your draft — *{goal excerpt}* (step 2 of 6)" for the most recent draft → `/studio?draft=:id`; other drafts as a "N more drafts" chip → the Studio picker |
| Run in flight | Live status card (current stage + progress, polling) → Studio `generating` state |
| Run awaiting a gate | "Your cut is waiting for review" → the gate |
| Run succeeded recently | "Review your rough cut" → Studio `review` state |
| Otherwise | "New video" CTA + recent outputs |

**Precedence (decided): urgency order.** When several states coexist, the hero
shows the most blocked/most expensive thing first:
**waiting gate > run in flight > unreviewed finished cut > draft in progress >
new video.** The losers render as small secondary chips under the hero (e.g.
"You also have a draft — continue"), never as a second hero.

The hero is the dashboard. Counts, grids, and filters are L3 (the Library).

### 2. Navigation diet: 3 zones, no topnav

Sidebar reduces to **Create · Library · Settings** (logo → Home):

- **Create** → `/studio` (the wizard). The sidebar "New video" CTA stays — it
  *is* the product.
- **Library** → one surface (decision 3) absorbing Projects, Runs, Assets,
  Outputs.
- **Settings** → a real (minimal) page replacing `WorkspaceStubPage`: theme,
  workspace, account, sign-out, and workspace-level generation defaults as
  they appear.

The `TOPNAV` bar is **deleted**. **Storyboard and Evals are user-facing
(decided)** — but neither earns a top-level rail slot; they get guided homes
instead:

- **Storyboard is project-scoped.** Entry points: the project's card/row in
  the Library and the wizard's Review step. The
  `/projects/:projectId/storyboard` route stays; the bare `/storyboard` route
  redirects to the Library (pick a project first).
- **Evals becomes a Library tab** (workspace-level quality view), alongside
  the collections.
- Both register palette commands.

`/uploads`, `/templates`, `/brand` **stay routed as stubs (decided)** but
leave primary nav: reachable via the palette and a quiet links group on the
Settings page. They keep their IA slot for upcoming work without spending
sidebar attention; uploads additionally surface inside the wizard's Footage
step and as a Library assets filter.

### 3. One Library

`/library` with tabs **Projects · Runs · Assets · Outputs**, reusing the
existing views in `DashboardCollectionsPage.tsx` as tab bodies (they keep
their filters, pagination, empty states). Old routes (`/projects`, `/runs`,
`/assets`, `/outputs`) become redirects to the matching tab so deep links
survive. One sidebar item replaces four; nothing is lost.

### 4. Flow continuity: the app always resumes

"One action at a time" requires the app to remember which action you were on:

- **Draft persistence — server-side, multi-draft from day one (decided).**
  `BriefDraft` + active step persist to the API on `update()` (debounced)
  and rehydrate on mount. **Users can hold many drafts** and pick between
  them: the Studio start screen lists existing drafts ("Continue a draft",
  most recent first) above the "Start a new video" CTA, and starting new
  always creates a new draft — no replace prompt. A stale or
  version-mismatched draft payload is discarded silently (clean break, no
  migration shims). Storage: drafts exist *before* a project does (the
  wizard only creates the project at Generate), so they cannot hang off
  `projects` — a workspace-scoped **`studio_drafts`** table (many rows per
  user per workspace, each its own draft id; versioned `jsonb` payload) on
  Supabase, RLS keyed on `current_app_user_id()` per
  [docs/supabase-identity-and-rls.md](../supabase-identity-and-rls.md).
  Cross-device write-conflict handling is explicitly out of scope:
  last-write-wins.
- **Active-run rehydration.** On mount, `useStudioFlow` checks for an
  in-flight run (persisted `projectId`/`runId`, verified via
  `getGenerationRun`) and enters `generating` directly. `RunProgressPage`
  remains the deep-link view; `/studio` becomes equally refresh-safe.

### 5. Command palette as the findability backstop

⌘K from anywhere opens a palette indexing: navigation (all routes incl.
admin), actions ("New video", "Continue draft", "Approve waiting gate"), and
settings/options by name ("aspect ratio", "review gates", "captions" — each
jumps to its home surface with the relevant disclosure opened). Hand-rolled
on existing primitives (a filtered list in a dialog) — no new dependency.

## Shared contracts (agree before parallel work)

- **`WorkspacePulse`** — the dashboard summary response of
  `GET /api/v1/workspaces/:workspaceId/dashboard`, per the shape already
  specified in [dashboard-ui.md](./dashboard-ui.md) (`counts`, capped
  `activeRuns` with `currentStageType`/`progressPercent`, capped
  `recentOutputs`). Typed in `packages/shared/src/v1/`. One request renders
  Home.
- **`deriveNextAction(pulse, drafts): NextAction`** — a pure function in
  `apps/web/src/lib/nextAction.ts` returning a typed union
  (`start | resume_draft | watch_run | review_gate | review_cut | new`).
  The Home hero is a dumb renderer of this value; any future surface (palette,
  sidebar badge) reuses the same derivation. One implementation of "what
  should the user do next."
- **Draft persistence interface** — `listDrafts() / createDraft() /
  loadDraft(id) / saveDraft(id, draft, step) / deleteDraft(id)` in
  `apps/web/src/lib/draftStore.ts`, versioned payload
  (`{ v: 1, draft, step, projectId?, runId? }`), backed by the
  `GET/POST /api/v1/workspaces/:workspaceId/studio-drafts` +
  `GET/PUT/DELETE …/studio-drafts/:draftId` collection routes.
  `useStudioFlow` consumes only the interface; saves are debounced (~1s) and
  last-write-wins.
- **Palette command registration** — per repo convention, **no central
  `index.ts` aggregator**. Each feature owns a `commands.ts`
  (`studio/commands.ts`, `library/commands.ts`, …) exporting
  `Command[] = { id, title, keywords, run(navigate) }`; the palette collects
  them via explicit imports in `components/palette/registry.ts` (a small,
  reviewable mount file).
- **Disclosure-ladder review check** — every PR description states which
  ladder level each new/moved surface occupies. Anything placed at L3+ must
  name its palette entry.

## PRs

### PR 1 — API: workspace dashboard summary *(backend-only; unblocks Home)*
- **Files:** `apps/api/src/routes/v1/workspaces.ts` (alongside the existing
  assets/generation-runs/outputs handlers), shared types in
  `packages/shared/src/v1/`.
- **Work:** `GET /api/v1/workspaces/:workspaceId/dashboard` per
  dashboard-ui.md — counts (projects, active runs, outputs), `activeRuns`
  (capped, with denormalized `projectName`, `currentStageType`,
  `progressPercent`), `recentOutputs` (capped). RLS-scoped like the sibling
  routes; `Cache-Control: no-store`.
- **Done when:** one request returns everything the Home hero + outputs strip
  need; works in `AUTH_MODE=local`.

### PR 2a — API: server-side studio drafts *(backend-only; independent)*
- **Files:** new Supabase migration (`studio_drafts` table + RLS), new
  `apps/api/src/routes/v1/studio-drafts.ts` (mounted via the protected-routes
  registration file, per repo convention — no catch-all index), shared types
  in `packages/shared/src/v1/`.
- **Work:** collection routes —
  `GET/POST /api/v1/workspaces/:workspaceId/studio-drafts` (list newest
  first / create) and `GET/PUT/DELETE …/studio-drafts/:draftId` — many
  drafts per user per workspace, versioned `jsonb` payload plus a derived
  display excerpt (goal snippet + step + `updatedAt`) so the picker and Home
  hero render without parsing payloads. RLS keyed on
  `current_app_user_id()` (read
  [docs/supabase-identity-and-rls.md](../supabase-identity-and-rls.md)
  first). Unique migration timestamp (parallel-agent collision gotcha).
- **Done when:** drafts round-trip for the authed user, list newest-first,
  and are invisible to other users; works in `AUTH_MODE=local`.

### PR 2b — Studio continuity: drafts + picker + run rehydration *(depends on PR 2a; biggest UX win)*
- **Files:** new `apps/web/src/lib/draftStore.ts`;
  `components/studio/useStudioFlow.ts` (debounced persist on `update()`/
  `startGeneration()`, rehydrate by draft id, clear on export/abandon);
  `StudioShell.tsx` + `StudioEmptyState.tsx` → a **start screen**: "Start a
  new video" CTA above a "Continue a draft" list (excerpt + step + updated
  time, delete affordance per row).
- **Work:** decision 4. `/studio` with drafts shows the picker (or
  rehydrates directly when deep-linked as `/studio?draft=:id` from the Home
  hero); "Start new" always creates a fresh draft. Refreshing mid-brief
  restores the draft and step; refreshing mid-generation lands back in
  `generating` with the checklist live; a succeeded-but-unreviewed run lands
  in `review`.
- **Done when:** kill the tab at any wizard point, reopen `/studio` (even in
  another browser), and you can resume that draft in one click; multiple
  drafts coexist and are individually resumable and deletable.

### PR 3 — Home launchpad *(depends on PR 1; PR 2a/2b enable `resume_draft`)*
- **Files:** new `apps/web/src/routes/HomePage… → routes/LaunchpadPage.tsx`
  replacing the `/dashboard` use of `DashboardPlaceholderPage`; new
  `lib/nextAction.ts`; new `components/home/HeroCard.tsx`,
  `components/home/RecentOutputsStrip.tsx`.
- **Work:** decision 1. Poll the pulse while runs are active (reuse the
  existing tab-visibility cadence from `useStudioFlow`/progress views). Hero
  renders `deriveNextAction`; below it, a single quiet recent-outputs strip
  and a "Browse library" link (L3). Delete `DashboardPlaceholderPage`'s
  dashboard variant.
- **Done when:** login lands on a page whose single prominent element tells
  you what to do next, and it's correct for all six states in the table.

### PR 4 — Navigation diet *(independent of PRs 1–3; coordinate file overlap with PR 6)*
- **Files:** `components/AppLayout.tsx` + module CSS; `App.tsx` routes; new
  minimal `routes/SettingsPage.tsx` (replaces `WorkspaceStubPage` for
  `/settings`); delete `TOPNAV`.
- **Work:** decision 2. Sidebar → Create, Library, Settings (+ admin section
  housing Admin/AdminEvals per the existing flag). `/uploads`, `/templates`,
  `/brand` **keep their routes** but leave primary nav (linked from a quiet
  Settings group + palette). Bare `/storyboard` redirects to the Library;
  the project-scoped storyboard route is untouched. Settings page gets theme
  + workspace + account + sign-out (folding in the account-menu items).
  Delete dead placeholder pages and `TOPNAV`.
- **Done when:** an authenticated user sees exactly 3 nav items (+ admin when
  flagged); no duplicate Studio links; every demoted destination is still
  routable and reachable from Settings or the palette.

### PR 5 — Library unification *(pairs with PR 4; can land either order behind redirects)*
- **Files:** new `routes/LibraryPage.tsx` (tab shell); reuse
  `RunsPage`/`AssetsPage`/`OutputsPage` bodies from
  `DashboardCollectionsPage.tsx` + a projects list view; `App.tsx`
  (`/library/:tab?` + redirects from `/projects`, `/runs`, `/assets`,
  `/outputs`).
- **Work:** decision 3. Tab state in the URL; filters/pagination/empty states
  unchanged; the `/projects` placeholder is replaced by a real projects tab
  (cards: name, derived status, last activity — per dashboard-ui.md's
  Projects view, **with a Storyboard entry point per project card**). Add an
  **Evals tab** wrapping the existing `EvalsPage` (`/evals` redirects to it).
- **Done when:** one sidebar item reaches all collections plus Evals; old
  URLs redirect; a project's storyboard is one click from its card; nothing
  previously listable is lost.

### PR 6 — Command palette *(depends on PR 4's final nav set; consumes PR 3's `nextAction`)*
- **Files:** new `components/palette/Palette.tsx`, `registry.ts`; per-feature
  `commands.ts` files (`studio/`, `home/`, `library/`, settings); a ⌘K
  listener mounted in `AuthenticatedAppLayout`.
- **Work:** decision 5. Index navigation, actions (including the current
  `NextAction`), and named options — option entries deep-link to their home
  surface and open the owning disclosure (e.g. "review gates" → Generate
  step, advanced panel open). Keyboard-first; no new dependency.
- **Done when:** every route, action, and L2+ option in the app is reachable
  by typing its name from anywhere.

### PR 7 — Findability audit + polish pass *(last; QA of the ladder)*
- **Files:** copy/CSS touch-ups across the surfaces above; palette registry
  additions for anything missed.
- **Work:** walk every config option in the app and verify rules 1–4 of the
  ladder: one L0 per screen, ≤ 2 interactions from relevance, palette entry
  for everything L3+. Fix violations; align copy with
  `components/studio/copy.ts` tone.
- **Done when:** the acceptance table below passes end to end.

## Dependency graph & merge order

```
PR 1 (API summary) ─────────► PR 3 (Home launchpad) ──┐
PR 2a (API drafts) ─► PR 2b (continuity) ─► (resume) ─┤
                                                      ├─► PR 6 (palette) ─► PR 7 (audit)
PR 4 (nav diet) ──┬───► (final nav set) ──────────────┘
PR 5 (library) ───┘   (4 ↔ 5 either order; both touch App.tsx routes)
```

- **Start immediately, in parallel:** PR 1 + PR 2a (backend, different
  files), PR 4 (chrome). PR 5 right behind PR 4 (or before it — redirects
  make the order safe).
- **Then:** PR 2b once 2a lands; PR 3 once PR 1 lands; PR 6 once the nav set
  is final; PR 7 last.
- **Cross-plan:** finishing the wizard's Footage/Review/Export steps
  (studio-redesign-prs.md PRs 3/6/7) proceeds in parallel and shares no files
  with this plan except `useStudioFlow.ts` (see hotspots).

## Merge hotspots

- **`components/AppLayout.tsx`** — PR 4 (nav) and PR 6 (palette mount) both
  touch it; sequence 4 → 6, and keep the palette mount to a one-line addition.
- **`App.tsx` routes** — PR 3, 4, 5 all edit the route table. Land redirect
  changes in the PR that owns the destination; rebase rather than splitting
  routes into an aggregator file.
- **`useStudioFlow.ts`** — PR 2 here, plus the wizard's remaining step PRs in
  the other plan. PR 2 only adds persistence around the existing `update`/
  `startGeneration` seams; coordinate timing with whoever owns Review/Export.
- **`DashboardCollectionsPage.tsx`** — PR 5 re-homes its views. If PR 5
  splits it into per-tab files, do the move in one PR with no behavior change.

## Risks / open decisions

_Resolved during scoping (2026-06-10, with product):_ **Storyboard and Evals
are user-facing** — Storyboard stays project-scoped (entered from project
cards + the Review step), Evals becomes a Library tab; neither gets a rail
slot. **Drafts are server-side and multi-draft from day one** (`studio_drafts`
collection + picker, PRs 2a/2b); cross-device write conflicts are explicitly
not handled (last-write-wins).
**Templates/Brand Kit/Uploads keep their stub routes** but leave primary nav
(Settings links + palette). **Hero precedence is urgency order** (gate > run >
unreviewed cut > draft > new), with losers as secondary chips.

- **Library: one page vs. four.** Tabs-on-one-route is chosen for nav
  quietness; if tab bodies grow heavy, code-split per tab rather than
  re-promoting routes to the sidebar.
- **Hero polling load.** Home polls the pulse while runs are active *and* the
  Studio checklist may be polling the same run. Reuse the tab-visibility
  backoff and keep the pulse interval lazy (~5s+); don't add a second
  per-run poller.
- **Palette scope creep.** v1 is navigation + actions + option deep-links.
  Content search (find an asset by name) is explicitly out of scope until the
  Library lands and proves the need.

## Acceptance criteria → where satisfied

| Criterion | PR(s) |
|---|---|
| Login lands on a single, correct "do this next" action (urgency order) | PR 1, 3 |
| Refresh/return resumes exactly where the user left off — on any device | PR 2a, 2b |
| Multiple drafts coexist; each is resumable/deletable from the Studio picker | PR 2a, 2b, 3 |
| A run in flight is visible from Home and one click from its live status | PR 1, 3 |
| Sidebar shows ≤ 3 primary destinations; no duplicate nav | PR 4 |
| All collections + Evals reachable from one Library item; old URLs redirect | PR 5 |
| Storyboard one click from its project; Evals/stub pages findable, not loud | PR 4, 5, 6 |
| Settings is a real page; theme/account config lives there | PR 4 |
| Every config option ≤ 2 interactions from where it's relevant | PR 7 (audit; mostly true today via L2 disclosures) |
| Every route/action/option findable by name via ⌘K | PR 6, 7 |
| No placeholder pages, dead routes, or legacy nav left in the tree | PR 3, 4, 5 |
