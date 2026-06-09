# Repository structure — a one-pager

How this repo is organized and where to find things. For product/vision read
[`README.md`](../README.md) and [`docs/NORTH_STAR.md`](NORTH_STAR.md); for agent
conventions read [`CLAUDE.md`](../CLAUDE.md) and [`AGENTS.md`](../AGENTS.md).

## The big picture

Popcorn Ready is a **pnpm + Turbo monorepo**. There are two stacks in the tree:

- ✅ **Active** — the monorepo: a Vite SPA (`apps/web`), an Express API
  (`apps/api`), and shared libraries (`packages/*`). **All new work goes here.**
- ⚠️ **Legacy** — `src/` is the original **Next.js monolith**. Its `src/lib`
  already moved into `packages/` and `apps/api`; `src/app` (Next routes) +
  `src/components` linger but are **not in the monorepo build** (the workspace is
  only `apps/*` + `packages/*`, there's no `next.config`). It's being removed
  ("Track C"). **Do not add to `src/`.**

The product never edits raw video — agents produce/patch a **structured
timeline**, and rendering (Remotion) is deterministic.

## Directory map

```
apps/
  web/   (@popcorn/web)  Vite + React Router SPA → Netlify. The studio/dashboard UI.
    src/main.tsx          entry; mounts <App/> + imports the global CSS
    src/App.tsx           the route table (one <Route> per page)
    src/routes/           one file per page (HomePage, StudioPage, Login/Signup, Admin…)
    src/components/        AppLayout, Editor, PromptComposer, ThemeToggle,
                           + auth/ editor/ storyboard/ progress/ evals/
    src/lib/              api-client.ts, supabase/ (browser auth), dashboard/, evals/, v1/
    src/styles/           tokens.css / base.css / utilities.css (the global layer) +
                           the legacy globals.css being migrated to CSS Modules (see AGENTS.md)

  api/   (@popcorn/api)  Express API → Railway. Generation/job stack + Supabase access.
    src/index.ts          process entry (reads PORT, starts the server)
    src/env.ts            loads repo-root .env* before anything reads process.env
    src/server.ts         Express app wiring (cors, request context, error handler)
    src/routes/v1/        HTTP routes — public-routes.ts, protected-routes.ts, mount.ts
    src/middleware/        auth.ts, errors.ts, request-context.ts
    src/core/             adapter.ts, errors.ts, ids.ts
    src/lib/              backend logic: agent/ agent-api/ generation-run/ generative/
                           oneshot/ eval/ assets/ edit-graph/ provenance/ store.ts
                           supabase/ v1/ uploaded-footage.ts

packages/   shared workspace libraries (apps import them as `@popcorn/* : workspace:*`)
  shared/    (@popcorn/shared)    core types + data contracts: types.ts, edit-graph.ts,
                                  assets/, generative/, story-context.ts, audio-alignment.ts
  agent/     (@popcorn/agent)     Claude/LLM functions (planEdit, critique, revise,
                                  stitch-continuity-review) + the Anthropic client
  timeline/  (@popcorn/timeline)  timeline model, composition, render-plan
  renderer/  (@popcorn/renderer)  Remotion compositions (Root, VideoComposition) — render/export
  eval/      (@popcorn/eval)      eval framework (cli, policy, registry, context)

supabase/   Postgres schema (migrations/), seed.sql, config.toml. The DB/auth/storage layer.
docs/       NORTH_STAR.md (vision), scopes/ (design docs + PR plans), research/, audits/,
            supabase-identity-and-rls.md, repository-structure.md (this file)
public/     static assets (brand, fonts)
scripts/    standalone dev/eval scripts
src/        ⚠️ legacy Next.js monolith — not in the build, being removed. Don't touch.
```

Root config: `pnpm-workspace.yaml`, `turbo.json` (task graph), `tsconfig.base.json`,
`railway.toml` (API deploy), `netlify.toml` (web deploy), `.env.local` (local secrets, git-ignored).

## Where key things live

| Looking for… | Go to |
| --- | --- |
| The web route table / pages | `apps/web/src/App.tsx`, `apps/web/src/routes/` |
| HTTP API endpoints | `apps/api/src/routes/v1/` |
| The agent (LLM) functions | `packages/agent/src/` (+ `apps/api/src/lib/agent*`) |
| Generation pipeline / jobs | `apps/api/src/lib/generation-run/`, `generative/`, `oneshot/` |
| Core types & data contracts | `packages/shared/src/types.ts`, `edit-graph.ts` |
| DB schema / migrations | `supabase/migrations/` |
| Styling conventions | `AGENTS.md` (CSS Modules + token layer) |
| Identity / RLS model | `docs/supabase-identity-and-rls.md` |
| Vision / target architecture | `docs/NORTH_STAR.md`, `CLAUDE.md` |

## Build & run

```sh
pnpm install                 # install the whole workspace
pnpm dev                     # turbo: run every package's dev task
pnpm dev:api                 # just the Express API   (@popcorn/api)
pnpm dev:web                 # just the Vite SPA       (@popcorn/web)
pnpm typecheck               # turbo: run every package's typecheck task
pnpm test                    # turbo: run every package's test task
pnpm lint                    # turbo: run every package's lint task
```

Local dev: the API listens on `PORT` (default 4000); the web SPA (Vite, `:3000`)
proxies `/api` to `VITE_API_URL`. Env lives at the **repo root** (`.env.local`
wins; the API's `src/env.ts` loads it cwd-independently). Run with
`NODE_ENV=development`.

## Deploy targets

- **Web** → Netlify (`netlify.toml`)
- **API** → Railway (`railway.toml`)
- **DB** → Supabase; migrations applied by the `Apply Supabase migrations`
  GitHub Action on merge to `main`.
