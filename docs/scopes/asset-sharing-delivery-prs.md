# Asset Sharing & Delivery — Execution Plan (PR breakdown)

**Status: planned · June 11, 2026**

## What this document is

The architecture for public/private asset storage and delivery is already
settled in
[`public-private-asset-storage.md`](./public-private-asset-storage.md)
(S3 + CloudFront, two buckets, port the `harper-medical` storage layer). That
scope is still correct, but it was written before the asset-graph migration
and before the first visibility PRs landed, and **none of its implementation
PRs have shipped** — there is no `@aws-sdk/*` dependency, no
`apps/api/src/lib/storage/` module, no signed-URL code path, and no AWS infra
provisioned anywhere.

This document is the **execution plan**: what has changed since that scope was
written, what "sharing works" concretely means, the PR sequence to get there,
and the test story (including the manual local verification we currently
can't do). Architectural detail lives in the original scope; this doc only
records deltas and sequencing.

## Current state (verified against the repo, June 11 2026)

Done since the original scope:

- **Asset-graph migration preserved the storage contract.** The rebuilt
  `public.assets` table (`supabase/migrations/20260610120000_asset_graph_model.sql`)
  keeps `remote_url`, `storage_key`, `storage_bucket`, and `visibility`, with
  the same semantics the original scope assumed (`storage_bucket` = physical
  delivery location tracking *effective* visibility). No schema work is needed.
- **Visibility flag toggle shipped (metadata only).**
  `PATCH /projects/:projectId/assets/:assetId/visibility`
  (`apps/api/src/routes/v1/assets.ts`) calls `setAssetVisibility()`
  (`apps/api/src/lib/api/v1/store.ts`), which updates the `visibility` column
  and nothing else — no byte move, because there are no buckets yet.
- **Tier gating is detached.** `20260609020000_allow_all_visibility_toggle.sql`
  dropped the tier→visibility triggers; all users can toggle visibility. The
  `owner_tier` RPC still drives `defaultVisibilityForWorkspace()` for
  write-time defaults. The original scope's references to the DB tier trigger
  as a write-path guard no longer apply until billing re-attaches them.
- **Discovery API is live but returns no playable media.** `/discover/projects`,
  `/discover/assets`, `/discover/search`
  (`apps/api/src/routes/v1/discover.ts`) filter by effective-public via RLS,
  but rows carry raw `storage_key` / `remote_url` — no resolved URLs.
- **Supabase Storage stays for eval fixtures only.** The eval stack uses
  `lib/supabase/storage.ts` (`useSupabaseStorage`, fixture upload/download).
  The `createSignedAssetUrl()` delivery helper in that file is dead code on
  the asset path and is **removed** when the S3 read path lands (PR4) — no
  dual-backend delivery, per the no-legacy-code convention.
- **Test harness:** `apps/api` runs `node:test` via `tsx --test` (see
  `apps/api/package.json`); no vitest. Storage tests below target that harness.

Not started (everything byte- and URL-shaped):

- AWS SDK packages, the `lib/storage/` module, presigned/CloudFront signing,
  the S3 write path, `resolveAssetUrl()`, the byte-moving visibility
  reconcile, direct browser upload, and all AWS provisioning.

## Definition of done — "sharing works"

End to end, a user can:

1. **Upload or generate an asset** → bytes land in the bucket matching its
   effective visibility; the row has `storage_key` + `storage_bucket`.
2. **Toggle the asset (or its project) public** → bytes move to
   `assets-public`; the asset appears in `/discover/*` with a **stable
   CloudFront URL** anyone can open in a browser.
3. **Toggle it private** → bytes move to `assets-private`, the CloudFront key
   is invalidated, and the only working URL is a **short-lived signed URL**
   minted for the owner; the old public URL stops resolving.
4. **Every step above is covered by automated tests** against a local S3
   stand-in (MinIO), and reproducible by hand with the smoke script + curl
   flow in §Manual verification.

## PR breakdown

Numbering continues the original scope's plan; each PR is independently
shippable and lands dark behind `STORAGE_BACKEND` until PR0's infra exists.

### PR0 — AWS provisioning (ops, parallel)

No code. Create in AWS + Railway:

- `assets-public` bucket: CloudFront distribution + OAC, public read via CDN
  only, long TTL.
- `assets-private` bucket: private, no distribution (S3 presigned GET first;
  CloudFront-signed delivery is a later config-only upgrade — settled).
- Bucket CORS for the web origin (`PUT`/`POST` + multipart headers) — needed
  before PR3 goes live.
- CloudFront signing key-pair (held for the later signed-CDN upgrade).
- Railway env vars per the original scope §6 (`STORAGE_BACKEND=s3`,
  `AWS_REGION`, credentials, bucket names, `S3_PUBLIC_URL_BASE`,
  `CF_SIGN_KEY_PAIR_ID`/`CF_SIGN_PRIVATE_KEY`).

Deliverable: filled-in env values + a short `docs/railway-deployment.md`
update. Blocks nothing from *landing*; blocks PR2+ from being *enabled* in
deployed environments.

### PR1 — Storage foundation (dark) + local test rig

- Add `@aws-sdk/client-s3`, `@aws-sdk/cloudfront-signer`,
  `@aws-sdk/s3-request-presigner` to `apps/api`.
- Port the four `harper-medical` modules into `apps/api/src/lib/storage/`
  per the original scope §1: `config.ts`, `s3-client.ts`, `cloudfront.ts`,
  `s3-presign.ts`, `object-store.ts`, plus `local-store.ts` behind the
  `STORAGE_BACKEND` flag (`local` default = today's `.local/media` behavior).
  ESM imports, visibility-keyed bucket resolution instead of harper's
  `"contracts"` exception.
- **Test rig:** a `docker-compose.minio.yml` (or LocalStack) +
  `AWS_ENDPOINT_URL_S3` / `S3_FORCE_PATH_STYLE=true` wiring in `config.ts`,
  and `node:test` suites covering put/get/copy/delete, `objectUrl` shape, and
  the signed-URL fallback chain (CloudFront → S3 presign → unsigned).
- `.env.local.example` gains the storage env block.

No behavior change — nothing calls the module yet.

### PR2 — Write path (server-mediated)

- On asset create/generate (`registerAsset()` in
  `apps/api/src/lib/api/v1/assets.ts`, plus the generated-asset pipeline),
  compute effective visibility, `putObject` to the matching bucket with
  `ContentType`, persist `storage_key` (`{ws}/{proj}/{assetId}/{filename}`)
  + `storage_bucket`, leave `url` null.
- `multipart_upload` (base64) and `local_path` sources route through the same
  store interface; `remote_url` stays passthrough.
- Record the storage write on the asset's provenance like other generated-asset
  actions (consistent with the asset-graph `actions` conventions from #281).
- Backfill script for existing rows (expected near-zero volume — confirm
  before running).
- Tests: write path sets bucket by effective visibility; free-tier default
  visibility (`owner_tier` RPC) lands in `assets-public`.

### PR3 — Direct browser→S3 upload

- `lib/storage/uploads.ts` + routes: `POST .../assets/upload-url` (presigned
  PUT, or multipart-init + presigned parts for large video) and
  `POST .../assets/:assetId/complete` (verify object exists, finalize row).
  Shapes per original scope §3(b).
- The minted URL's bucket is itself the authorization guard (a public project
  can only ever receive a PUT into `assets-public`).
- Requires PR0's bucket CORS before it works from the deployed web origin;
  testable locally against MinIO without it.
- Web (`apps/web`) upload flow switches to this path in the same PR or an
  immediate follow-up — no `.local/media` upload path survives.

### PR4 — Read path (this is where sharing becomes visible)

- `lib/storage/asset-urls.ts`: `resolveAssetUrl(asset)` /
  `resolveAssetUrls(assets[])` per original scope §4 — `remote_url`
  passthrough; public bucket → stable `S3_PUBLIC_URL_BASE` URL; private →
  short-lived presigned GET (TTL 300s).
- Wire into every payload that returns media: workspace asset list
  (`mapAsset` in `apps/api/src/lib/api/v1/store.ts`), `/discover/*`
  responses, run/dashboard output payloads.
- **Delete** the dead `createSignedAssetUrl()` Supabase delivery helper
  (eval-fixture storage functions in the same file stay).
- Tests: public → unsigned stable URL, private → signed URL with expiry,
  `remote_url` unchanged, discovery rows always resolve to stable URLs.

### PR5 — Visibility toggle moves bytes + project cascade

- `lib/storage/visibility-move.ts`: `reconcileAssetStorage()` with the
  settled copy → update row → delete ordering and the flag-vs-bucket
  separation from original scope §5 (project toggles never rewrite per-asset
  flags).
- Upgrade the existing `setAssetVisibility()` from flag-only to
  flag + reconcile; add `setProjectVisibility()` + a
  `PATCH /projects/:projectId` `{ visibility }` route (does not exist today)
  with the eager per-asset cascade.
- CloudFront invalidation on every privatize move (settled decision).
- Record visibility changes as asset-graph `actions` rows so provenance shows
  who published/privatized what, when.
- Tests: reconcile ordering and mid-failure orphan behavior;
  effective-visibility matrix (asset public + project private → private
  delivery); project republish restores the exact prior effective-public set;
  privatize invalidates the key.

### PR6 — Smoke script + manual test docs

Small but explicitly scoped, because today there is no way to manually
verify sharing at all:

- `apps/api/scripts/storage-smoke.ts` (run via `tsx`): against the configured
  backend (MinIO locally, real AWS in staging) — create asset → assert bytes
  + row → toggle public → fetch the stable URL unauthenticated → toggle
  private → assert the public URL 403s and a signed URL works → clean up.
- `docs/manual-tests/asset-sharing.md`: the curl-level walkthrough (§Manual
  verification below) for humans.

## Testing summary

| Layer | Where | What |
|---|---|---|
| Unit/integration | `apps/api/src/lib/storage/__tests__/` (`tsx --test`) vs MinIO | object ops, URL shapes, signing fallback chain, reconcile ordering, effective-visibility matrix |
| Write path | PR2 tests | bucket selection by effective visibility, row fields |
| Read path | PR4 tests | resolver matrix incl. `remote_url` passthrough |
| End-to-end smoke | `scripts/storage-smoke.ts` (PR6) | the full share/unshare lifecycle vs MinIO or real AWS |
| Manual | `docs/manual-tests/asset-sharing.md` (PR6) | human-runnable curl flow |

## Manual verification (the flow PR6 documents)

Local, no AWS account needed after PR1–PR5:

1. `docker compose -f docker-compose.minio.yml up -d`; run the API with
   `STORAGE_BACKEND=s3`, `AWS_ENDPOINT_URL_S3=http://localhost:9000`,
   `S3_FORCE_PATH_STYLE=true`, the two bucket names, and dummy credentials.
2. Register an asset (`POST .../assets` with `multipart_upload` or the PR3
   upload-url handshake) → confirm the object in MinIO's console under
   `{ws}/{proj}/{assetId}/...` and `storage_bucket` on the row.
3. `PATCH .../assets/:id/visibility {"visibility":"public"}` → object moved
   to `assets-public`; `GET /discover/assets` (unauthenticated) returns the
   asset with a stable URL that opens in a browser.
4. `PATCH .../assets/:id/visibility {"visibility":"private"}` → object moved
   back; the old URL stops working; the authenticated asset list returns a
   signed URL that expires (~5 min).
5. Repeat at the project level via `PATCH /projects/:id` and confirm the
   republish restores the exact prior public set.

Staging/production verification is the same flow with real AWS env values
(after PR0), plus checking the CloudFront invalidation on privatize.

## Deltas from the original scope (recorded, not re-litigated)

- **Tier triggers are detached** (`20260609020000`); the scope's "DB tier
  trigger guarantees free → public bucket" guard is currently inert. The
  write path computes the bucket from the row's visibility either way, so
  nothing in this plan depends on the trigger; billing re-attaches it later.
- **Asset-graph provenance:** visibility changes and storage writes record
  `actions` rows (PR2/PR5) — the original scope predates the graph's action
  log and didn't mention it.
- **Supabase delivery path is deleted, not kept as fallback** (PR4). The
  original scope left it unaddressed; the repo convention is clean breaks.
- **A dedicated smoke/manual-test PR (PR6)** is added; the original scope had
  automated tests only.

Everything else — bucket topology, key scheme, copy→update→delete ordering,
flag-vs-bucket independence, S3-presign-first private delivery, invalidation
on privatize, thumbnails inheriting their parent — stands as settled in
[`public-private-asset-storage.md`](./public-private-asset-storage.md).
