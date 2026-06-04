# Supabase cutover & target architecture — PR roadmap

Tracks the work to move Popcorn Ready off the `.local/` JSON stores onto Supabase
(Postgres + Storage + Auth), scoped into PRs that **parallelize**. Each PR lists
its dependencies so independent ones can run concurrently.

**Scope of this roadmap:** the database/Supabase cutover — Tracks **A** (schema),
**C** (store→Postgres), **D** (bytes→Storage), **F** (invites). Track **E**
(monorepo split) is a **separate, concurrent effort owned by another agent**; it
appears here only because C/D land inside its new API package, i.e. as a
dependency we don't own. Track **B** (auth) has its own foundation branch.

> **This is a proposed breakdown — edit freely.** Status reflects the state as of
> this doc's creation. See [`../supabase-identity-and-rls.md`](../supabase-identity-and-rls.md)
> for the identity model that underpins most of this.

## Target architecture & stack decisions

The cutover happens *inside* a broader shift off the Next.js monolith. Decisions
made so far (this is the record — update as they evolve):

- **Off the Next.js monolith → a monorepo split.** Next was the fast-start
  full-stack choice, but its SSR / React-Server-Component model is friction for a
  logic-heavy *authenticated* studio app, and long-running generation jobs fit a
  real server better than serverless route handlers. SSR only earns its keep on a
  public/SEO landing page.
- **Frontend: Vite + React Router v7 (data mode) SPA → Netlify.**
  - Vite is the modern replacement for Create React App (CRA is deprecated — do
    not use it).
  - React Router v7 **loaders/actions** provide route-level *data routing* (the
    route declares its data; loaders call the Express API). Used in **data mode**
    (`createBrowserRouter`, pure SPA) — no SSR/framework layer, which is the point.
  - Add **TanStack Query** later only if client server-state caching needs it; not
    upfront. (TanStack Router is the type-safe alternative to React Router if it
    ever comes up.)
  - "SPA" here means client-rendered + client-routed — it is a *full* app with all
    the dashboard logic, not a single screen.
- **Backend: Express API → Railway.** Owns business logic, the generation/job
  stack, Supabase access, and the auth middleware.
- **Data & auth: Supabase** (Postgres + Storage + Auth). Identity keys on
  `public.users.id` (domain id); `auth.uid()` is mapped to it only inside RLS via
  `current_app_user_id()` (the golden rule below). Auth follows the **harper-server
  middleware pattern** in the Express API: verify the Supabase JWT (`setSession`) →
  a **user-scoped, RLS-enforced** client (via AsyncLocalStorage) → resolve to the
  `public.users.id`. Data access runs through the user-scoped client so **RLS
  enforces tenancy**; `service_role` is reserved for trusted ops (invites, system
  jobs).
- **Open — landing/SEO:** keep a thin SSR/static landing (Next or plain static)
  only if the public page needs SEO; the app itself is the SPA.

## Guiding invariant

**The auth user id (`auth.uid()` / `auth.users.id`) is never used outside RLS.**
All app code, tables, and APIs key on the domain id `public.users.id` via
`public.current_app_user_id()`. Every PR below must uphold this — see the
"Golden rule" in [`../supabase-identity-and-rls.md`](../supabase-identity-and-rls.md).

## Status legend

`✅ merged` · `🔄 in review` · `⬜ todo` · `🧊 blocked (see deps)`

## Tracks

The work falls into five tracks. Schema (A) and Auth (B) are mostly independent
and can start now; the store/storage cutovers (C/D) land **inside** the monorepo
split (E) and depend on schema; the invite flow (F) depends on schema + auth.

---

### Track A — Schema migrations (Supabase Postgres)

Pure SQL migrations. Parallelizable **except** where two touch the same objects
(then serialize by timestamp). These are the unblockers for C/D/F.

| PR | Scope | Status | Depends on |
|----|-------|--------|-----------|
| A1 | v1 model schema + Storage bucket foundation (`#125`) | ✅ merged | — |
| A2 | `public.users` decoupled from `auth.users` + identity/RLS docs (`#127`) | ✅ merged | A1 |
| A3 | `workspace_members` + unify workspace authz on domain id (`#128`) | ✅ merged | A2 |
| A4 | `workspace_invites` (email, role, token, expiry) — or confirm the `auth_id`-null + members-row approach is enough | ⬜ todo | A3 |
| A5 | Push the Storage bucket migration (`20260603000100`) to remote (ops, not a PR) | ⬜ todo | A1 |
| A6 | Audit remaining auth-id usage; confirm everything keys on `current_app_user_id()`. Known offender: `src/lib/api/v1/auth.ts` derives `ws_user_<auth_uid>` and `Actor.id = auth user id` — switch to `public.users.id` (part of Track C cutover) | ⬜ todo | A3, C1 |

### Track B — Auth (app)

Per the architecture decision above, auth lands in the **SPA** (login/signup +
session) and the **Express API** (the harper-server middleware). The login/signup
UI + Supabase clients currently exist *uncommitted* in the `feat/movie-dream`
working tree — they need extracting to a clean branch and porting to the SPA.

| PR | Scope | Status | Depends on |
|----|-------|--------|-----------|
| B1 | Auth UI + Supabase client in the SPA: login/signup, session, `AuthProvider` (extract from the uncommitted `feat/movie-dream` tree, port to Vite) | ⬜ todo | E2 |
| B2 | Auth middleware in the Express API (harper-server pattern): verify JWT (`setSession`) → user-scoped RLS client (AsyncLocalStorage) → resolve `current_app_user_id()` → `public.users.id`. **Not** in the Next monolith. | ⬜ todo | E1, A2 |
| B3 | SPA sends the session token on API calls; API rejects unauthenticated requests | ⬜ todo | B1, B2 |

### Track C — DB cutover (store → Postgres)

Per the earlier decision, the store cutover is built **fresh in the monorepo-split
API package** (not retrofitted into the Next monolith — no `DB_BACKEND` dual-path
shim). Depends on the API package existing (E1) and the schema (A).

| PR | Scope | Status | Depends on |
|----|-------|--------|-----------|
| C1 | Postgres-backed foundation store (workspaces/projects/brief_versions/assets/idempotency) | 🧊 todo | E1, A1–A3 |
| C2 | Postgres-backed job/timeline store (compositions/jobs/timelines/edit_graphs/generation runs) | 🧊 todo | E1, A1 |
| C3 | Wire the service_role admin client + `SUPABASE_SERVICE_ROLE_KEY` config | ⬜ todo | — |

### Track D — Storage cutover (asset bytes → Supabase Storage)

Move asset files off `.local/media` + `public/generated` into the private `assets`
bucket. Also lands in the split.

| PR | Scope | Status | Depends on |
|----|-------|--------|-----------|
| D1 | Storage write path: uploads + generated assets → bucket; `storageKey` = object path | 🧊 todo | E1, A5, C3 |
| D2 | Storage read path: render/export resolve bytes from the bucket (signed URLs / download) | 🧊 todo | D1 |

### Track E — Monorepo split (infra) — *owned by another agent*

**Not scoped by this roadmap** — listed only as a dependency, since C/D land
inside the new API package. Owned by the separate monorepo-split effort
(`monorepo-split` worktree). E1 (API package) gates C/D.

| PR | Scope | Status | Depends on |
|----|-------|--------|-----------|
| E1 | Express API package scaffold (Railway), pnpm + Turborepo | 🔄 in progress | — |
| E2 | Vite + React Router v7 (data mode) SPA package (Netlify) | ⬜ todo | E1 |
| E3 | Shared packages / types extraction | ⬜ todo | E1 |

### Track F — Invite flow (app)

The end-to-end "add a teammate to your workspace" UX, on top of the membership
schema. The DB-side linking is already handled by `handle_new_user`; this is the
API + UI.

| PR | Scope | Status | Depends on |
|----|-------|--------|-----------|
| F1 | Invite API: create `public.users` (`auth_id` NULL) + `workspace_members` row; send invite | ⬜ todo | A3 (A4?), C1 |
| F2 | Accept-on-signup UX (DB links automatically; app routes the new user into the workspace) | ⬜ todo | F1, B1 |
| F3 | Members management UI (list / change role / remove) | ⬜ todo | F1 |

---

## Suggested waves (what to parallelize)

**Wave 1 — start now, fully parallel:**
- A4 (invites schema) · A5 (push bucket migration) · A6 (auth.uid audit)
- B1 → B2 (auth)
- E1 (API package scaffold) — unblocks Wave 2

**Wave 2 — after E1 + schema merged, parallel:**
- C1, C2 (store cutover) · C3 (service-role config)
- D1 (storage write)

**Wave 3:**
- D2 (storage read) · F1 → F2/F3 (invite flow) · E2/E3 (SPA + shared)

## Critical path

`A1 → A2 → A3` (done) → `E1` → `C1/C2` → `D1 → D2`. Auth (B) and the invite UI
(F) run alongside without blocking the store/storage cutover.

## Open questions

- **A4**: do we need a dedicated `workspace_invites` table (tokens/expiry/pending
  state), or is "create a `public.users` row with `auth_id` NULL + a
  `workspace_members` row, adopted on signup by email" sufficient?
- **Cutover location**: confirm C/D land only in the split API package (not the
  monolith), and whether the monolith keeps running on `.local` until the split
  is the deploy target.
- **Sessions/SSR**: do we adopt `@supabase/ssr` for cookie-based sessions, or stay
  with the current browser-token + bearer model?
