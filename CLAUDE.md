# Popcorn Ready — agent guide

AI-native video studio. The product never touches raw video — agents produce and
edit a **structured timeline**, and rendering is deterministic.

## Read this first

**[docs/NORTH_STAR.md](docs/NORTH_STAR.md)** is the authoritative vision for how
video generation should evolve: **one agent-orchestrated, non-one-directional
pipeline** where stages are tools the agent calls, runs are autonomous by
default, any stage can be re-triggered, and changes recompute only the affected
assets via a dependency/provenance graph. Align new generation work to it; flag
deviations explicitly. Do **not** entrench the old forward-only "edit the
timeline with patches" model.

## Direction (target architecture)

The app is **moving off the Next.js monolith** into a monorepo split. Target stack:

- **Frontend:** Vite + **React Router v7 (data mode)** SPA → Netlify — the
  authenticated dashboard + all client logic. (Vite replaces CRA; do not add CRA.
  Avoid building new SSR/RSC-coupled logic — Next's server model is what we're
  leaving.)
- **Backend:** **Express API** → Railway — business logic, the generation/job
  stack, Supabase access, and the harper-server-style auth middleware.
- **Data/auth:** **Supabase** (Postgres + Storage + Auth). App identity is
  `public.users.id`; `auth.uid()` maps to it only inside RLS via
  `current_app_user_id()`. The server talks to Supabase as the **user-scoped,
  RLS-enforced** client; `service_role` only for trusted ops.

The Next monolith still runs today on the `.local/` JSON stores; **new
DB/Storage/auth work targets the split, not the monolith.** Full plan + PR
breakdown: [docs/scopes/supabase-cutover-prs.md](docs/scopes/supabase-cutover-prs.md).
Identity rules: [docs/supabase-identity-and-rls.md](docs/supabase-identity-and-rls.md).

## Where things live

- Live generation: `src/app/api/oneshot/` (sync) + `src/lib/runs/execute.ts`.
- Versioned/job stack: `src/lib/v1/`, `src/lib/api/v1/`, `src/app/api/v1/`.
- The agent (LLM) functions: `src/lib/agent/` (`planEdit`, `critiquePlan`,
  `critique`, `revise`, …). Generation/keyframes: `src/lib/generative/`.
- Core types: `src/lib/types.ts`. Edit graph: `src/lib/edit-graph.ts`.
- Scopes & design docs: `docs/scopes/`, `docs/research/`.

## Conventions

- Run the dev server with `NODE_ENV=development` (a stray `NODE_ENV=test` makes
  Next skip `.env.local` and drop API keys).
- Directory shape should reduce shared edit hotspots while keeping code
  modular. Prefer cohesive feature/route files plus small explicit mount files
  over broad `index.ts` aggregators. When adding Express route groups, add or
  update the smallest registration file that owns that auth/feature boundary
  (for example `public-routes.ts` or `protected-routes.ts`) instead of funneling
  unrelated work through a catch-all index file.
- Avoid creating new `index.ts` files as cross-module aggregation points unless
  there is a strong local convention and no lower-conflict alternative. Names
  like `mount.ts`, `routes.ts`, `client.ts`, or feature-specific files are easier
  to review and less likely to collide across parallel agent PRs.
- Character/keyframe images of minors must use Gemini (OpenAI image-edit rejects
  editing photorealistic minors).
- Supabase/RLS: `public.users.id` (app/domain id) is **not** `auth.uid()` — they
  are linked by `public.users.auth_id`. RLS policies on app tables must compare
  to `public.current_app_user_id()`, not `auth.uid()`. Before writing any
  migration or policy that touches users, read
  [docs/supabase-identity-and-rls.md](docs/supabase-identity-and-rls.md).
