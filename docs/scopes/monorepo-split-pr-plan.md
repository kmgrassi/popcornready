# Monorepo Split — Parallelizable PR Plan

A work plan for finishing the Next-monolith → monorepo split, decomposed into
discrete PRs that can be dispatched to independent agents. Read
[`MIGRATION.md`](../../MIGRATION.md) first for the overall shape and the route/
page parity matrix.

## Where we are (all merged to `main`)

- **#124** monorepo scaffold (pnpm + Turborepo; `apps/{api,web}`, `packages/*`).
- **#126** deploy prep (dropped root Next config; API runtime prod-safe).
- **#129** extracted `@popcorn/shared` + `@popcorn/timeline` (subpath exports).
- **#131** relocated `src/lib/**` → `apps/api/src/lib/**`, `src/remotion` →
  `@popcorn/renderer`, browser Supabase client → `apps/web/src/lib/supabase`.

State today:
- `apps/api` (Express) serves only `GET /api/v1/health`; **all server logic is
  present** under `apps/api/src/lib/**` (with a `@/* → src/*` alias that works at
  build time and under `tsx` at runtime), but the route handlers are not wired.
- `apps/web` (Vite SPA) is a placeholder shell, **live on Netlify**
  (popcornready.ai). `@popcorn/{shared,timeline,renderer}` are populated.
- The **old `src/app/**` route handlers and `src/components/**`/pages still
  exist** as the porting source. They are NOT built by any workspace (CI/Netlify
  builds only `@popcorn/web`), so they can dangle until deleted in Track C.

## Conventions — apply to EVERY PR

1. Branch off the latest `main`. Use pnpm (`pnpm install`, never npm/yarn).
2. **Green gate:** `pnpm exec turbo run typecheck` must pass, and
   `pnpm --filter @popcorn/web build` must still succeed (it's the Netlify build).
   Run the relevant app/package's own checks too.
3. **No legacy / no back-compat code.** Clean break to the v1 contract — do not
   add compatibility shims or keep dual code paths. (Project rule.)
4. Keep the **`api/v1` contract stable** (same paths, payloads, response
   envelopes, `X-Request-Id`) per [`api-contract-v1.md`](./api-contract-v1.md).
   Behavior parity with the old Next handler is the bar.
5. Port by **reading the old source** in `src/app/**` / `src/components/**`,
   creating the new file under `apps/**`, and leaving the old file in place
   (Track C deletes them). Do not edit old `src/**` except to delete.
6. Align new generation work to [`docs/NORTH_STAR.md`](../NORTH_STAR.md); flag
   deviations. Don't entrench the forward-only model.
7. Commit messages end with the `Co-Authored-By` trailer; PR bodies end with the
   `🤖 Generated with Claude Code` line. One PR per item below.

## Dependency graph (what blocks what)

```
A0 (api core) ──> A1 A2 A3 A4 A5   (parallel after A0)
                  A6 A7            (parallel after A0; contract-design heavier)
B0 (web shell) ─> B1 B2 B3 B4 B5 B6 (parallel after B0)

A0 and B0 are independent → start both immediately, in parallel.
B1–B6 do NOT block on A1–A7: pages port against the @popcorn/shared contract
types and the API client; full runtime wiring is finished in C1.
C0, C1 run last (after the route + page ports land).
```

**Recommended dispatch:** assign **A0** and **B0** first (two agents). As soon as
each merges, fan out its dependents (A1–A7 to several agents; B1–B6 to several).

## Coordination notes (avoid merge conflicts between parallel PRs)

- **`apps/api/src/routes/v1/mount.ts`** owns the `/api/v1` Express mount and the
  public-before-auth / protected-after-auth boundary. Route groups should live in
  their own files and be registered through the smallest relevant mount file
  (for example `public-routes.ts` or `protected-routes.ts`) instead of a broad
  `index.ts` aggregator.
- **`apps/web/src/App.tsx`** route table is the web equivalent — B0 sets it up so
  each page PR adds one `<Route>` line.
- Each route group lives in its **own file**; each page/component in its own
  file. Avoid adding new `index.ts` aggregation points for parallel work; prefer
  explicit module names that describe the boundary they own.
- `apps/api/src/core/{errors,ids}.ts` were scaffold stubs. **A0 owns
  reconciling** them with the real `apps/api/src/lib/api/v1/{errors,ids}.ts`
  (consolidate to one). Later PRs must not re-fork them.

---

# Track A — Express API

## A0 — Framework-agnostic api-core + Express adapter (FOUNDATION, blocks A1–A7)

**Branch:** `feat/api-core-express-adapter`
**Goal:** Remove the Next coupling from the request lifecycle and provide the
adapter every route group will use, proven on the `me` + `projects` routes.

**Background:** `apps/api/src/lib/api/v1/handler.ts` already has `handleRead` /
`handleMutation` whose `fn` returns a plain `ApiResult` (`{ status, body,
headers? }`); only the edges touch `NextRequest`/`NextResponse`. The v1 route
files in `src/app/api/v1/**` call these handlers. `resolveAuth(req)` in
`apps/api/src/lib/api/v1/auth.ts` reads the bearer token off `NextRequest`.

**Scope / steps:**
1. Introduce a tiny framework-agnostic request view used by the core:
   `interface ApiRequestView { method; pathname; searchParams: URLSearchParams;
   header(name): string | null; rawBody(): Promise<string>; }`.
2. Refactor `handler.ts` so `handleRead`/`handleMutation` take an
   `ApiRequestView` and **return `ApiResult`** (no `NextResponse`). Refactor
   `resolveAuth` (and `bearerToken`) to read the `authorization` header from the
   view, not `NextRequest`.
3. Add `apps/api/src/core/adapter.ts`: `route(fn)` / `mutation(fn)` Express
   handlers that build an `ApiRequestView` from the Express `req` (query →
   searchParams, `req.params`, `Idempotency-Key`, raw body for hashing — add
   `express.json({ verify })` or a raw capture so the idempotency body hash
   matches the old behavior), invoke the core, then serialize `ApiResult` /
   `ApiError` to the response with `X-Request-Id`. Reuse the existing error
   middleware envelope.
4. **Consolidate** `apps/api/src/core/errors.ts` + `core/ids.ts` (scaffold
   stubs) with `lib/api/v1/errors.ts` + `lib/v1/ids.ts` — one canonical
   `ApiError` (with `.envelope()`) and id helpers; update imports.
5. Establish the mounting pattern in `routes/v1/mount.ts` plus focused
   registration files: each group exports a `Router` (or `register(v1)`) and is
   mounted in the smallest file that owns its public/protected boundary.
   Document why broad `index.ts` aggregators are avoided.
6. **Port `GET /api/v1/me` and `projects` (`GET`/`POST /projects`,
   `GET /projects/:projectId`)** as the reference implementation, using the new
   schemas/store from `@/lib/api/v1/*`. Keep paths/payloads identical.
   `projects/:projectId` is **GET-only** today — do not add a `PATCH`.

**Acceptance:**
- `pnpm exec turbo run typecheck` green; API boots.
- `curl` parity for `/api/v1/health`, `/api/v1/me`, `GET/POST /api/v1/projects`,
  `GET /api/v1/projects/:id` (auth in `AUTH_MODE=local`): same status,
  body envelope, and `X-Request-Id` as the old Next handlers.
- A short "how to add a route group" note in the PR description.

## A1 — Assets routes
**Branch:** `feat/api-route-assets` · **Depends on:** A0
**Source:** `src/app/api/v1/projects/[projectId]/assets/route.ts`,
`…/assets/[assetId]/route.ts`, `…/assets/inventory/route.ts`,
`…/assets/[assetId]/context/route.ts`.
**Scope:** port to an `assets` Express router, preserving the **exact existing
verbs**: `GET/POST /assets`, `GET /assets/:assetId`, `POST /assets/inventory`
(inventory is POST, not GET), `PATCH /assets/:assetId/context` (context is PATCH)
— using `@/lib/api/v1/assets.ts`. Mount in the focused v1 protected route
registration file.
**Acceptance:** typecheck green; curl parity for each (same verbs).

## A2 — Brief routes
**Branch:** `feat/api-route-brief` · **Depends on:** A0
**Source:** `…/brief/route.ts`, `…/brief-versions/route.ts`.
**Scope:** `brief` router (`GET/PUT /brief`, `GET/POST /brief-versions` —
brief-versions exports **both** GET and POST; the create endpoint mints the
immutable brief version generation jobs reference, so it must be ported). Mount.
**Acceptance:** typecheck green; curl parity for all four verbs.

## A3 — Generations & generated-assets
**Branch:** `feat/api-route-generations` · **Depends on:** A0
**Source:** `…/generations/route.ts`, `…/generations/[jobId]/route.ts`,
`…/generated-assets/route.ts`, `…/generated-assets/[jobId]/route.ts`.
**Scope:** routers for `generations` (`POST /generations`,
`GET /generations/:jobId`) and `generated-assets` (`POST /generated-assets`,
`GET /generated-assets/:jobId`) using `@/lib/api/v1/generated-assets.ts` +
`@/lib/v1/generation/*`. The **collection routes are POST-only**; `GET` exists
only on `/:jobId` — do not add collection `GET`s. Mount.
**Acceptance:** typecheck green; curl parity incl. `Idempotency-Key` on POST.

## A4 — Generation runs
**Branch:** `feat/api-route-generation-runs` · **Depends on:** A0
**Source:** `…/generation-runs/route.ts`, `…/[runId]/route.ts`, and
`…/[runId]/{approve,reject,cancel,retry}/route.ts`.
**Scope:** `generation-runs` router (`GET/POST`, `GET /:runId`, `POST
/:runId/approve|reject|cancel|retry`) using `@/lib/v1/generation-runs/*`. Mount.
**Acceptance:** typecheck green; curl parity incl. the run state transitions.

## A5 — Timelines, revisions, exports, artifacts
**Branch:** `feat/api-route-timelines` · **Depends on:** A0
**Source:** `…/timelines/[timelineId]/revisions/route.ts`,
`…/timelines/[timelineId]/revisions/[jobId]/route.ts`,
`…/timelines/[timelineId]/exports/route.ts`, `…/exports/[jobId]/route.ts`,
`…/artifacts/[artifactId]/route.ts`. (There is **no** bare
`timelines/[timelineId]/route.ts` — the timeline resource only has the nested
sub-collections below.)
**Scope:** nested `timelines/:timelineId` routes — `POST
/timelines/:timelineId/revisions`, `GET /timelines/:timelineId/revisions/:jobId`,
`POST /timelines/:timelineId/exports` — plus top-level `GET /exports/:jobId` and
`GET /artifacts/:artifactId`. Export/render uses `@popcorn/renderer` +
`@remotion/renderer` (server). Mount.
**Acceptance:** typecheck green; curl parity (same verbs); a render/export smoke
if feasible.

## A6 — Re-express generation entry points as v1 (NO legacy)
**Branch:** `feat/api-v1-generation-entrypoints` · **Depends on:** A0
**Heavier — involves contract design, not just a move.**
**Source (old non-v1):** `src/app/api/oneshot/route.ts`,
`src/app/api/generate/route.ts`, `src/app/api/generate-assets/route.ts`,
`src/app/api/revise/route.ts` (+ helpers in `apps/api/src/lib/oneshot/*`,
`agent/*`, `agent-api/*`, `generative/*`).
**Scope:** define clean **v1** endpoints for these capabilities (do NOT port the
`/api/*` paths verbatim — fold them into the v1 resource model, ideally the
generation-run/asset-pool flow per NORTH_STAR). Propose the v1 paths in the PR
description before implementing; align with `api-contract-v1.md`. Mount under
`/api/v1`. **Acceptance:** typecheck green; documented v1 endpoints with curl
examples; the oneshot/generate flow runs end-to-end in `AUTH_MODE=local`.
> If the contract design balloons, split into its own scope doc first.

## A7 — Re-express remaining capabilities as v1 (NO legacy)
**Branch:** `feat/api-v1-misc-capabilities` · **Depends on:** A0
**Source (old non-v1):** `export`, `exports`, `compositions[/:id]`,
`characters/**`, `assets/[assetId]/character-review`, `align-audio`, `upload`,
`debug/**`.
**Scope:** fold the still-needed ones into v1 resources (e.g. uploads → assets,
characters → character_anchor assets, export → timelines exports). **Drop**
anything not carried forward (likely most of `debug/**`) and `log()`-note what's
dropped in the PR. **Acceptance:** typecheck green; documented v1 endpoints;
parity for the flows the web app actually uses.

---

# Track B — Web (Vite React SPA)

## B0 — SPA foundation (FOUNDATION, blocks B1–B6)

**Branch:** `feat/web-spa-foundation`
**Goal:** the shell every page plugs into.

**Scope / steps:**
1. **Styles:** move `src/app/globals.css` + `src/styles/{base,tokens,utilities}.css`
   into `apps/web/src/styles/**`, import from `main.tsx`.
2. **Root layout/providers:** port `src/app/layout.tsx` into an `AppLayout` +
   providers. Port `ThemeToggle` and `LogoMark` (`src/components/`) into
   `apps/web/src/components/`. Port `AuthProvider` (`src/components/auth/`) using
   the already-moved `apps/web/src/lib/supabase/browser.ts` — and **fix the P1
   env bug there**: public env must be `import.meta.env.VITE_SUPABASE_*` (Vite),
   referenced statically, not `process.env`.
3. **Typed API client:** `apps/web/src/lib/api-client.ts` — base URL from
   `import.meta.env.VITE_API_URL` (dev: Vite proxy already forwards `/api`),
   attaches the Supabase bearer token (port `supabase/fetch.ts` logic), parses
   the `{ error: {...} }` envelope, and is typed against `@popcorn/shared/v1/types`.
4. **Remotion Player wrapper:** a `Preview`-ready component using
   `@remotion/player` + `@popcorn/renderer/VideoComposition` +
   `@popcorn/timeline` render-plan. (Full `Preview.tsx` port can be in B3.)
5. Set up `App.tsx` so each page adds one `<Route>`; document the pattern.

**Acceptance:** `pnpm --filter @popcorn/web build` green; the shell renders;
`api-client` compiles against the contract types; document "how to add a page".

## B1 — Auth pages
**Branch:** `feat/web-auth` · **Depends on:** B0
**Source:** `src/app/login/page.tsx`, `src/app/signup/page.tsx`,
`src/components/auth/{AuthForm,AuthNavButton}.tsx`.
**Scope:** `/login`, `/signup` routes + components, using `AuthProvider` + the
Supabase browser client. **Acceptance:** web build green; sign-in/up flow works
against a Supabase project (or documented env).

## B2 — Home / landing
**Branch:** `feat/web-home` · **Depends on:** B0
**Source:** `src/app/page.tsx`. **Scope:** `/` route. **Acceptance:** build green;
renders.

## B3 — Studio (editor)
**Branch:** `feat/web-studio` · **Depends on:** B0
**Source:** `src/app/studio/page.tsx`, `src/components/Editor.tsx`,
`src/components/Preview.tsx`, `src/components/PromptComposer.tsx`,
`src/components/editor/**`.
**Scope:** `/studio` route + the editor surface; data via `api-client`; preview
via the B0 Player wrapper. Largest web PR. **Acceptance:** build green; editor
renders and talks to the API client.

## B4 — Run progress
**Branch:** `feat/web-run-progress` · **Depends on:** B0
**Source:** `src/app/projects/[projectId]/runs/[runId]/page.tsx`,
`src/components/RunProgress.tsx`, `src/components/progress/**`,
`src/components/generation-progress/**` (+ the `v1/generation-runs/client` &
`recovery` helpers — relocate the client-side ones into `apps/web`).
**Scope:** `/projects/:projectId/runs/:runId` route + progress UI + polling/
recovery via `api-client`. **Acceptance:** build green; progress view renders.

## B5 — Admin
**Branch:** `feat/web-admin` · **Depends on:** B0
**Source:** `src/app/admin/page.tsx`. **Scope:** `/admin` route.
**Acceptance:** build green.

## B6 — Dev tools
**Branch:** `feat/web-dev-tools` · **Depends on:** B0
**Source:** `src/app/dev/generation-cards/page.tsx`. **Scope:**
`/dev/generation-cards` route. **Acceptance:** build green.

---

# Track C — Cleanup & deploy (LAST)

## C0 — Delete the old Next app
**Branch:** `chore/remove-old-next-app` · **Depends on:** all of A & B merged.
**Scope:** delete `src/app/**`, `src/components/**`, `src/styles/**`, and any
remaining root Next files/deps; confirm nothing references `src/**`. Update
`MIGRATION.md` checkboxes. **Acceptance:** `turbo run typecheck` + web build
green with `src/` gone; `grep -r "@/lib\|src/app" apps packages` clean.

## C1 — Live deploy wiring
**Branch:** `chore/deploy-wiring` · **Depends on:** A0–A7, B0.
**Scope:** stand up the Railway API service (dashboard — owner task; see
`railway.toml`), set Netlify `VITE_API_URL` → Railway origin and Railway
`WEB_ORIGIN` → `https://popcornready.ai`, finalize CORS + env separation, and
run an end-to-end smoke (web → API auth + a generation). Switch the API `start`
to a compiled build if moving off `tsx`. **Acceptance:** documented green
end-to-end on the deployed apps.

---

## Quick reference — counts

- Track A: **8 PRs** (A0 foundation + A1–A5 mechanical ports + A6–A7 contract-design).
- Track B: **7 PRs** (B0 foundation + B1–B6 pages).
- Track C: **2 PRs**.
- Critical path: `A0 → A6/A7`, `B0 → B3`, then `C0 → C1`.
