# Auth: Login / Signup → Dashboard — Scope

## Objective

Ship a working **email + password login and signup** flow that lands an
authenticated user on a **dashboard**, built as a **framework-agnostic auth core
behind a thin Next host** — so it works in today's Next monolith and ports to the
target Vite + React Router v7 SPA with near-zero rework.

Reference implementation: **`~/Desktop/repos/openmacaw`** (`platform/apps/web`) —
already Vite + React Router v7 + `@supabase/supabase-js`, the exact target stack.
We mirror its **code patterns** (auth store on `onAuthStateChange`, `AuthGate` /
`UnauthenticatedOnly` guards, Bearer-token injection with stale-session cleanup)
— **not** its configuration. We use **popcorn-ready's own Supabase project**,
never openmacaw's URLs/keys (§5).

## Decision (settled before scoping)

**Build target: portable core + thin Next host.** The auth *core* (Supabase
client, auth store, form logic, guard predicates) is built with **no Next or
router or env-prefix coupling**, consumed today by Next page shells and later by
the Vite SPA. Rejected: building straight into the Next monolith (cheap now,
re-port later) and standing up the Vite SPA now (correct target, but blocked on
the monorepo split and overlaps that in-progress work).

## What already exists (reuse, don't rebuild)

popcornready already has **working but uncommitted** Supabase auth scaffolding in
the Next monolith (on the `feat/movie-dream-*` working tree, not yet on `main`).
It is close to what we need; this scope mostly **refactors it into a portable
core + commits it**:

| File (in main repo working tree) | What it is | Disposition |
|---|---|---|
| `src/components/auth/AuthProvider.tsx` | React context: `{status, user, error, configured}`, `signIn/signUp/signOut`, `onAuthStateChange` + `getSession` hydrate | → fold into the portable auth **store** (drop navigation) |
| `src/components/auth/AuthForm.tsx` | login+signup form, password auth; **redirects to `/studio`** post-login | → split: portable form logic/UI in core; **redirect moves to host guard** |
| `src/components/auth/AuthNavButton.tsx` | sign-in link / sign-out button | → core presentational component |
| `src/lib/supabase/browser.ts` | client singleton, env (`NEXT_PUBLIC_SUPABASE_*`), storage-key namespacing, clear-stale helpers | → core `createSupabaseClient(config)` with **injected** config |
| `src/lib/supabase/fetch.ts` | `authenticatedFetch` — injects `Authorization: Bearer <token>` | → core; add 401 stale-session cleanup (openmacaw `maybeClearStaleSession`) |
| `src/lib/supabase/{server,admin,storage}.ts` | **server-side** clients (user-scoped, service-role, storage) | **not** part of the browser auth core — stay server-side, move to Express in the split |
| `src/lib/api/v1/auth.ts` | `resolveAuth()` — verifies bearer token, dual `local`/`supabase` mode | unchanged; the login UI only matters in `supabase` mode |
| `src/app/api/v1/me/route.ts` | returns `{actor, workspaceId, authMode, isLocal}` | the dashboard's identity/bootstrap call |

> **Practical note for PR 1:** because this scaffolding is uncommitted on another
> branch, the first task is to bring it onto this branch (copy/cherry-pick from
> the `feat/movie-dream-*` working tree) as the refactor's starting point — a
> fresh worktree off `main` does not contain it.

## Identity alignment (read first)

This flow produces the Supabase **auth** session; the **domain** identity is
`public.users`, resolved in the DB via `current_app_user_id()` (see
[docs/supabase-identity-and-rls.md](../supabase-identity-and-rls.md)). Two
consequences:

- **Signup auto-creates the domain user.** The `handle_new_user` trigger on
  `auth.users` inserts/adopts the `public.users` row — the client does nothing
  extra. (First/last name passed via `signUp` `options.data` flow into
  `raw_user_meta_data` and the trigger reads them.)
- **The client never sees `auth.uid()` semantics.** It holds a session + access
  token; the server maps token → `public.users.id`. The UI keys off the Supabase
  `User` only for display/session state.

`AUTH_MODE`: the API runs `local` by default (deterministic dev user, no login).
The login/signup UI is only meaningful under **`AUTH_MODE=supabase`** (hosted);
note this in env docs so local dev isn't confused by a login screen that "does
nothing."

---

## 1. Architecture — the portable core / host split

The rule that makes the port near-zero: **the core owns auth *state and actions*;
the host owns *navigation, env, and page shells*.** The core never imports a
router or reads a build-tool-specific env var.

### 1.1 `auth-core` (today `src/lib/auth-core/`, destined for `packages/auth-core`)

Zero coupling to Next / React Router / `NEXT_PUBLIC_*` / `import.meta.env`.

- **`createSupabaseClient(config)`** — singleton factory. Takes injected
  `{ url, anonKey, envName }` (host supplies it; core does **not** read env).
  Keeps openmacaw/existing **storage-key namespacing** (`sb-<env>-<ref>-auth`) and
  `clearOtherSupabaseAuthStorage()` / `clearAllSupabaseAuthStorage()` for
  multi-env/multi-tab hygiene. Exposes `getAccessToken()`.
- **`authStore`** — framework-agnostic store (recommend **Zustand**, per
  openmacaw; the existing React-context `AuthProvider` folds into it). Holds
  `{ status, user, error, configured }` where
  `status ∈ 'loading' | 'disabled' | 'unauthenticated' | 'authenticated'`.
  On `init()`: subscribe `onAuthStateChange` (`SIGNED_IN` / `TOKEN_REFRESHED` /
  `SIGNED_OUT`) + hydrate via `getSession()`. Actions: `signIn`, `signUp`,
  `signOut`. **No navigation, no router.** A thin `useAuth()` React hook binds it.
- **form logic** — pure `validateLogin()` / `validateSignup()` (trim email,
  non-empty, password min length, confirm match) + submit handlers that call
  store actions and surface error/loading. Presentational `<LoginForm>` /
  `<SignupForm>` are plain React (no router/env imports); they emit
  success/needs-confirmation, they do **not** redirect.
- **guard predicates** — `isAuthed(status)`, `isResolving(status)`,
  `isUnauthed(status)`. The guard *components* live in the host (they call the
  router); the core only provides the predicates + live status.
- **`authedFetch`** — Bearer injection + 401 → `maybeClearStaleSession()`
  (openmacaw pattern) for calls to the API.

### 1.2 Host adapter contract

A host provides exactly four things:

1. **env → config**: Next reads `NEXT_PUBLIC_SUPABASE_URL/ANON_KEY/ENV`; Vite
   reads `VITE_SUPABASE_*`; both build the same `config` object for the core.
2. **route shell**: page/route components that render core forms + the dashboard.
3. **guards**: `AuthGate` (bounce `unauthed` → `/login`) and
   `UnauthenticatedOnly` (bounce `authed` → `/dashboard`), implemented with the
   host's router (`next/navigation` `useRouter` today; RR v7 `<Navigate>` later),
   reading core status. **This is where post-auth redirect happens** — not in the
   form.
4. **token transport**: wire `authedFetch` into the app's API client.

> Why guards (not Next middleware) own redirects: Supabase web sessions live in
> client `localStorage`, so middleware can't see them reliably. Client-side
> guards watching store status are the portable, correct mechanism — and it's
> exactly what openmacaw does.

---

## 2. Auth flows

### 2.1 Login
`signInWithPassword({ email, password })`. On `SIGNED_IN`, store → `authenticated`;
`UnauthenticatedOnly` guard redirects to `/dashboard`. Errors surface inline
(invalid credentials, etc.). Clear stale storage on mount (existing behavior).

### 2.2 Signup
`signUp({ email, password, options: { data: { first_name, last_name } } })`.
Two outcomes, both already handled by the existing provider and openmacaw:
- **Email confirmation OFF** → Supabase returns a session immediately → treat as
  login → `/dashboard`.
- **Email confirmation ON** → no session → show "check your email"; the
  confirmation link returns to app origin where `init()` re-hydrates.

Whether confirmation is on is an **open decision** (§7); default **off** for MVP
so signup → dashboard works in one step.

### 2.3 Signout
`signOut()` + clear local storage → `SIGNED_OUT` → store `unauthenticated` →
`AuthGate` bounces protected routes to `/login`.

### 2.4 Session persistence & token
Supabase SDK persists the session in `localStorage` and auto-refreshes; `init()`
rehydrates on boot. `authedFetch` attaches the access token; a 401 with a
stale-auth code triggers local sign-out + storage clear.

---

## 3. Route protection & navigation

**Three** route classes. Note the deliberate divergence from openmacaw: **the
root `/` is a public landing page for everyone** — we do **not** auto-redirect
authenticated users off it into the dashboard.

| Class | Routes | Logged out | Logged in |
|---|---|---|---|
| **Public** | `/` (landing), marketing pages | render | **render (no bounce)** |
| **Unauthenticated-only** | `/login`, `/signup` | render | → `/dashboard` |
| **Protected** | `/dashboard`, `/studio`, `/projects`, … | → `/login` | render |

Guards (host components reading core status):

- **`AuthGate`** wraps protected routes: `resolving → spinner`, `unauthed →
  /login`, `authed → render`.
- **`UnauthenticatedOnly`** wraps `/login`, `/signup`: `authed → /dashboard`.
- **Public routes get no guard** — the landing page renders in both states.

Post-auth destination is **`/dashboard`** (replaces the existing
`AuthForm`→`/studio` redirect; the redirect now lives in `UnauthenticatedOnly`,
not the form).

### 3.1 Landing-page entry point — context-aware nav button

Because the landing page stays reachable while logged in, its primary auth
control adapts. This is the existing `AuthNavButton`, extended:

- **Logged out** → **"Log in"** → `/login`.
- **Logged in** → **"Dashboard"** → `/dashboard` (with sign-out still available,
  e.g. in an adjacent account menu).

So an authenticated user who navigates to `/` sees the full landing page with a
**"Dashboard"** button to jump in — never forced off it. The button derives its
label/target purely from core auth `status`, so it works identically in the Next
host now and the Vite host later.

### 3.2 Optional bootstrap

On first authenticated render, optionally call `GET /api/v1/me` to resolve
`workspaceId` / actor and cache it (openmacaw's `orchestrate` analog).
Lightweight — the dashboard can also just fetch it itself.

---

## 4. The dashboard destination

This scope delivers a **minimal authenticated landing at `/dashboard`** — enough
to prove the flow end to end: greets the user (from `/api/v1/me`), shows
workspace context + a sign-out button, and links to existing surfaces
(`/studio`, `/projects`). The **full** dashboard (overview cards, runs, assets,
outputs, nav shell) is owned by
[docs/scopes/dashboard-ui.md](./dashboard-ui.md); this is its integration point,
not its replacement. Building the minimal landing here keeps login→dashboard
shippable and parallelizable without waiting on the dashboard build.

---

## 5. Environment & config

**Supabase project: use popcorn-ready's own project**
(`mllkugitfwasiwgbortk.supabase.co`, per the existing `.env.local.example`) —
**never** openmacaw's. openmacaw is a code reference only; copy patterns, not
URLs or keys. The existing `src/lib/supabase/*` already points at the
popcorn-ready project; the refactor keeps those values and only changes *how* the
config is supplied (injected, not read directly).

Core takes an injected `config`; hosts read their own env:

```
# Next host (today)
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
NEXT_PUBLIC_SUPABASE_ENV=dev            # dev/prod selection (storage-key namespacing)
AUTH_MODE=supabase                      # the API must honor bearer tokens for login to mean anything

# Vite host (later) — same core, different prefix
VITE_SUPABASE_URL= / VITE_SUPABASE_ANON_KEY= / VITE_SUPABASE_ENV=
```

Optional dev-only quick-login buttons (openmacaw pattern, gated on `DEV`) via
`*_LOGIN_EMAIL` / `*_LOGIN_PASSWORD` to speed local testing.

Supabase Auth config (`supabase/config.toml`): confirm email/password provider
enabled, set Site URL + redirect allow-list (for confirmation/reset links), and
local email testing via Inbucket (`:54324`).

---

## 6. PR breakdown

1. **Extract `auth-core` + commit scaffolding.** Bring the uncommitted scaffolding
   onto this branch; refactor: inject config into the Supabase client, fold
   `AuthProvider` into the portable store, extract pure form logic/validation +
   presentational forms, add guard predicates + `authedFetch` (with 401 cleanup).
   Remove navigation from forms.
2. **Next host wiring.** `src/app/{login,signup}/page.tsx` render core forms;
   `AuthGate` / `UnauthenticatedOnly` guards via `next/navigation`; mount the
   store provider/hook at the app root.
3. **`/dashboard` minimal landing** + retarget post-auth redirect to `/dashboard`;
   `/api/v1/me` bootstrap.
4. **Supabase Auth config + env docs.** Provider settings, email-confirmation
   decision, redirect URLs, `.env.local.example` updates, `AUTH_MODE=supabase`
   note.
5. *(Later, separate scope)* **Vite SPA host** consuming the unchanged core —
   the payoff of the portable boundary.

---

## 7. Open decisions

- **Email confirmation** on signup: OFF (default — one-step signup→dashboard) vs
  ON (needs a confirmation/callback route + "check your email" UX). §2.2.
- **State lib for the core**: Zustand (openmacaw-aligned, provider-tree-free) vs
  keep the existing React context. Not load-bearing; recommend Zustand. §1.1.
- **Dashboard boundary**: minimal landing here vs pulling more of
  `dashboard-ui.md` forward. §4.
- **Local vs supabase mode in hosted envs**: keep dual-mode, or require
  `AUTH_MODE=supabase` everywhere but local dev. §"Identity alignment".
- **Future (out of scope, note only)**: OAuth/social providers, forgot-password /
  reset, magic-link — all additive on the same core.

_Resolved during scoping:_ build target = portable core + thin Next host
(openmacaw as the Vite-ready **code** reference only); reuse the existing
scaffolding rather than rebuild; **Supabase = popcorn-ready's own project**, never
openmacaw's; post-auth destination = `/dashboard` with the redirect in the host
guard (not the form); **root `/` stays a public landing for everyone**, with the
nav button reading "Dashboard" when logged in.
