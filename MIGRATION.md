# Monorepo split: Next monolith → Express API (Railway) + Vite SPA (Netlify)

This repo is being split from a single Next.js app into a pnpm + Turborepo
monorepo with two independently deployable apps.

## Target layout

```
apps/
  api/    @popcorn/api   Express server  → Railway   (railway.toml)
  web/    @popcorn/web   Vite React SPA  → Netlify   (netlify.toml)
packages/
  shared/    @popcorn/shared    isomorphic types, schemas, errors, ids, API contract
  timeline/  @popcorn/timeline  deterministic timeline ops, render-plan, audio-alignment
  renderer/  @popcorn/renderer  Remotion compositions (used by web Player + api renderer)
  agent/     @popcorn/agent     model prompts, generation/revision, providers
```

The API keeps an internal `@/*` → `apps/api/src/*` alias so the bulk of the
former `src/lib` server code moves with near-zero import churn. Only genuinely
shared modules (types + timeline/render logic the web needs) move into
`packages/*` and are imported by name from both apps.

## Status

- [x] Base: WIP Supabase auth committed onto the movie-dream base.
- [x] Monorepo scaffold: workspace config, deploy configs, Express + Vite
      bootstraps. Verified green (web build, API health + 404 envelope).
- [ ] Extract shared packages (shared / timeline / renderer / agent).
- [ ] Make api-core framework-agnostic (drop NextRequest/NextResponse from
      `handler.ts`, `responses.ts`, `http.ts`, `auth.ts`).
- [ ] Port all v1 routes to Express routers.
- [ ] Re-express the remaining non-v1 capabilities (oneshot, generate, export,
      compositions, characters, upload, …) as clean v1 routes — NO legacy/compat
      layer; the web app calls v1 only.
- [ ] Port pages + components to the Vite SPA with react-router.
- [ ] Web API client + Supabase browser auth + Remotion Player preview.
- [ ] Delete old `src/` Next app, `next.config.mjs`, root Next tsconfig.
- [ ] End-to-end local verification of both apps.

## Framework-agnostic core

`apps/api/src/core/*` holds the former `src/lib/api/v1` business logic with the
Next coupling removed:
- `handler.ts` returns a plain `ApiResult` (`{ status, body, headers? }`); the
  Express adapter serializes it. No `NextRequest`/`NextResponse`.
- Request access (`searchParams`, headers, raw body for idempotency hashing) is
  passed in by the Express route, not read off `NextRequest`.
- `ApiError.envelope(requestId)` is the single error body shape; the Express
  error middleware emits it.

## v1 route parity matrix (former Next handler → Express router)

| Method | Path | Source handler | Status |
| --- | --- | --- | --- |
| GET | /api/v1/health | app/api/v1/health | ✅ done |
| GET | /api/v1/me | app/api/v1/me | ⬜ |
| GET/POST | /api/v1/projects | app/api/v1/projects | ⬜ |
| GET/PATCH | /api/v1/projects/:projectId | app/api/v1/projects/[projectId] | ⬜ |
| GET/POST | /api/v1/projects/:projectId/assets | …/assets | ⬜ |
| GET | /api/v1/projects/:projectId/assets/:assetId | …/assets/[assetId] | ⬜ |
| GET/PUT | /api/v1/projects/:projectId/brief | …/brief | ⬜ |
| GET | /api/v1/projects/:projectId/brief-versions | …/brief-versions | ⬜ |
| GET/POST | /api/v1/projects/:projectId/generations | …/generations | ⬜ |
| GET | /api/v1/projects/:projectId/generations/:jobId | …/generations/[jobId] | ⬜ |
| GET/POST | /api/v1/projects/:projectId/generated-assets | …/generated-assets | ⬜ |
| GET | /api/v1/projects/:projectId/generated-assets/:jobId | …/generated-assets/[jobId] | ⬜ |
| GET/POST | /api/v1/projects/:projectId/generation-runs | …/generation-runs | ⬜ |
| GET | /api/v1/projects/:projectId/generation-runs/:runId | …/generation-runs/[runId] | ⬜ |
| POST | …/generation-runs/:runId/{approve,reject,cancel,retry} | …/[runId]/* | ⬜ |
| GET | /api/v1/projects/:projectId/artifacts/:artifactId | …/artifacts/[artifactId] | ⬜ |
| GET/POST | /api/v1/projects/:projectId/exports/:jobId | …/exports | ⬜ |
| * | …/timelines/:timelineId[/exports,/revisions] | …/timelines/* | ⬜ |

## Non-v1 capabilities → clean v1 (no legacy layer)

The current UI also uses non-v1 endpoints: `/api/project`, `/api/upload`,
`/api/generate`, `/api/generate-assets`, `/api/revise`, `/api/export`,
`/api/exports`, `/api/oneshot`, `/api/compositions[/:id]`, `/api/characters/*`,
`/api/assets/*`, `/api/align-audio`, `/api/debug/*`.

There is **no legacy/compatibility layer**. Each of these is re-expressed as a
clean v1 route (or dropped if not carried forward), and the SPA is written
against the v1 contract directly. We do not keep dual code paths or back-compat
shims alive.

## Web pages (former Next app router → react-router)

| Next route | SPA route | Source |
| --- | --- | --- |
| / | / | app/page.tsx |
| /studio | /studio | app/studio/page.tsx |
| /login, /signup | /login, /signup | app/{login,signup}/page.tsx |
| /admin | /admin | app/admin/page.tsx |
| /projects/:projectId/runs/:runId | same | app/projects/[projectId]/runs/[runId]/page.tsx |
| /dev/generation-cards | /dev/generation-cards | app/dev/generation-cards/page.tsx |

`app/layout.tsx` → SPA root layout/providers. `src/components/*` move under
`apps/web/src/components/*`. Server-only `fetch`/auth is replaced by the typed
API client (`apps/web/src/lib/api-client.ts`) targeting `VITE_API_URL`.

## Deployment

- **Railway (API):** service Root Directory = repo root; build/start commands in
  `railway.toml` filter the `@popcorn/api` workspace. Health: `/api/v1/health`.
  Env: `AUTH_MODE`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
  model provider keys, `WEB_ORIGIN` (CORS allowlist), `DB_BACKEND`.
- **Netlify (web):** `netlify.toml` builds `@popcorn/web`, publishes
  `apps/web/dist`, SPA redirect to `index.html`. Env: `VITE_API_URL` =
  Railway API origin, plus `VITE_SUPABASE_*` public keys.
