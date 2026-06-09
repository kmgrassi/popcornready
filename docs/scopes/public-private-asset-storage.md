# Public/Private Asset Storage & Delivery — S3 + CloudFront Implementation Scope

## Objective

Make Popcorn Ready actually **store asset bytes** and **serve them with the
correct public/private delivery semantics** the data model already defines.
Concretely:

- **Public** assets (and the assets of public projects) are served from a
  **stable, cacheable** URL fronted by a CDN — discoverable, hot-linkable,
  long-TTL.
- **Private** assets are served only through **short-lived signed** URLs —
  never publicly fetchable.
- Flipping an asset/project between public and private **moves the bytes** to
  the matching delivery surface, so "private" means *physically* unreachable,
  not just hidden in the DB.

This is the storage/delivery implementation that the data-model scope
([`user-tiers-content-visibility.md`](./user-tiers-content-visibility.md) §3.4,
§6) **explicitly deferred to "the implementation PR."** It targets the **split
architecture** (Express API on Railway + Supabase + AWS S3/CloudFront), not the
Next monolith. The decision to use **S3 + CloudFront, two buckets, reusing the
`harper-medical` storage layer** was already made in that scope and is taken as
settled here; this document is the *how*.

> Alignment with [NORTH_STAR](../NORTH_STAR.md): assets stay an immutable,
> project-scoped pool. Visibility is metadata + a physical delivery location;
> this scope adds the delivery layer, it does not add a new store or a
> copy-on-share mechanic for owners.

---

## Current state (grounded)

What exists today on `main`:

- **Schema is ready — no migration needed.** `public.assets`
  (`supabase/migrations/20260603000000_init_schema.sql`) already has
  `url`, `remote_url`, `storage_key`, `storage_bucket` (currently unused),
  and `visibility` (`init_schema.sql:493-515`). Tier→visibility enforcement,
  `owner_tier()`, and `public-read` RLS are live.
- **Write-time visibility default works.** `addAsset()` sets visibility via
  `defaultVisibilityForWorkspace()` → `owner_tier` RPC (paid → `private`,
  free → `public`) — `apps/api/src/lib/api/v1/store.ts:260-267,756-770`.
- **There is no real byte storage yet.** `registerAsset()`
  (`apps/api/src/lib/api/v1/assets.ts:306-396`) only accepts `remote_url`
  (stored as-is) and `local_path` (copied to `.local/media/...`). Multipart /
  cloud upload is explicitly out of scope in that file ("PR1") and unimplemented.
- **There is no real delivery yet.** URL resolution is
  `renderableAssetUrlFromRow()` → `url` → `source.url` → `remote_url` →
  `storage_key` (`apps/api/src/lib/v1/store.ts:180-193`). A Supabase Storage
  signer (`createSignedAssetUrl`, `apps/api/src/lib/supabase/storage.ts:92-101`,
  bucket `"assets"`, both Supabase buckets private) exists but is **not called**
  in any retrieval path. The discovery API (`/discover/*`,
  `apps/api/src/routes/v1/discover.ts`) returns rows but no resolved media URLs.
- **No AWS SDK is installed.** `apps/api/package.json` has no `@aws-sdk/*`.
- **Config pattern:** `apps/api/src/env.ts` loads dotenv (repo-root
  precedence); modules read `process.env` directly. `DB_BACKEND=supabase`
  toggles the Supabase path (`apps/api/src/lib/supabase/storage.ts:21`) — the
  pattern we mirror with a storage backend flag.

**Net:** the database is ready, but bytes effectively have nowhere durable to
live and no visibility-aware way to be served. This scope fills exactly that gap.

### The reusable layer (`harper-medical`)

The four modules named in the data-model scope are **self-contained** — their
only dependencies are `@aws-sdk/client-s3`, `@aws-sdk/cloudfront-signer`, and
`@aws-sdk/s3-request-presigner` (no harper DB/config/logger coupling, only a
local `storage.types`):

| harper module | role |
|---|---|
| `server/src/utils/aws/s3Client.ts` | cached, env-driven `S3Client` (region/endpoint/path-style) |
| `server/src/utils/cdn.ts` | CloudFront URL signing: `canSignCloudFront()`, `signCloudFrontUrl(url, expiresInSeconds=300)` |
| `server/src/utils/s3Signing.ts` | S3 presigned **GET** fallback (`buildPresignedS3Url`, `buildPresignedS3UrlFromPublicUrl`) |
| `server/src/api/storage/storage.repository.ts` | `storeFile` (PutObject), `getFile`, `objectUrl` (stable, honors `S3_PUBLIC_URL_BASE`), `getSignedFileUrl` (CloudFront-signed → S3-presigned → unsigned), bucket coercion, `ensureBucket` |

The single decision point to adapt is `getSignedFileUrl()`: harper keys
public-vs-signed off a hardcoded `bucketKey === "contracts"` exception. **We key
it off the asset's `storage_bucket` (i.e. effective visibility)** — a
one-function change.

---

## What this scope delivers

1. A ported, popcorn-owned storage module under `apps/api/src/lib/storage/`
   (ESM, no dynamic `require`), behind a `STORAGE_BACKEND` flag with a local-disk
   fallback so dev/test don't need AWS.
2. A **write path**: asset bytes are uploaded to the bucket matching the asset's
   *effective visibility* at creation; `storage_key` + `storage_bucket` are set.
3. A **read path**: a single `resolveAssetUrl(asset)` that returns a stable
   CloudFront URL for public assets and a short-lived signed URL for private
   ones, wired into the workspace asset list, discovery, and run outputs.
4. A **visibility toggle + eager cascade**: cross-bucket object move
   (copy → update row → delete) for asset publish/privatize, and the eager
   project→private cascade, plus the thin endpoints to trigger them.
5. The **infra checklist + env contract** to provision the two buckets and
   CloudFront in the deploy.

### Out of scope (own scopes / later)

- **Billing → tier.** Tier flips remain a trusted-role concern (the
  `guard_user_tier_update` trigger); no Stripe here.
- **Discovery UI and the asset/visibility dashboard UI.** This scope makes the
  API return correct URLs; rendering them is the web scope.
- **Consume (copy-on-add-to-project) + `saved_assets` bookmark endpoints.** They
  reuse `CopyObject` from this layer but are their own endpoint-shape scope
  (data-model §5.3).
- **Browser-direct presigned PUT upload** for large files. This scope does
  server-mediated `PutObject`; a direct-to-S3 upload handshake is a follow-up
  (noted in Open Questions).
- **Attribution/licensing** (data-model §7).

---

## Decisions

Inherited from the data-model scope (treated as settled):

- **Two buckets, not prefixes.** `assets-public` (public-read, CloudFront,
  stable cacheable URLs) and `assets-private` (private origin, signed URLs only).
  Visibility is *where the bytes live*.
- **`storage_bucket` tracks `effective_public(asset)`**, not the asset's own flag
  alone (effective = asset public **and** project public).
- **Eager cascade**: project→private moves its public assets to `assets-private`
  as part of the toggle.
- **Toggle order**: `CopyObject` → update row → `DeleteObject` original, so a
  mid-failure orphans a harmless source object (sweepable), never a row pointing
  at a deleted key.

New decisions for this implementation:

- **The `visibility` flag and `storage_bucket` are independent.** A row's
  `visibility` flag is *user intent* and changes only via an explicit toggle of
  *that* row; `storage_bucket` tracks *effective* visibility (where the bytes
  live) and is reconciled on any effective change. A **project** toggle
  reconciles its assets' bytes but **never rewrites their asset-level flags** —
  so re-publishing a project restores the exact prior effective-public set.
  (Raised in PR review; see §5.)
- **Identical object key in both buckets.** The `storage_key` is
  `{workspaceId}/{projectId}/{assetId}/{filename}` and is **stable across a
  visibility move** — only the bucket changes. This makes the move a pure
  same-key `CopyObject` and keeps `storage_key` immutable; only `storage_bucket`
  is rewritten.
- **URL is derived at read time, never persisted.** Leave the `url` column null
  for stored objects (it stays a passthrough only for `remote_url`-sourced
  assets). The served URL is computed from `storage_bucket` + `storage_key` on
  every read, so signed URLs never go stale in the DB and a moved object is
  always served correctly. (Matches data-model §3.4.)
- **`STORAGE_BACKEND` flag** (`s3` | `local`), mirroring `DB_BACKEND`. Default
  `local` (disk under `.local/media`, today's behavior) so nothing breaks
  without AWS env; `s3` enables the new layer. Lets us land the code dark and
  flip per-environment.
- **Content-Type on upload.** `PutObject` sets `ContentType` (from the filename
  extension / provided MIME) so CloudFront/S3 serve correct headers; no DB
  column is added (MIME stays derivable / in `source`/`context`).
- **ESM, static imports.** harper's CommonJS `require()` indirection is replaced
  with normal ESM imports during the port; the graceful-degradation behavior
  (no CloudFront key → fall back to S3 presign → unsigned) is preserved via
  `canSignCloudFront()` checks, not try/catch-around-require.

Resolved in PR review (see §10 for the one-line rationale each):

- **Private delivery = S3 presigned GET first**; CloudFront-signed is a later
  config-only upgrade.
- **Privatize issues a CloudFront invalidation** for the key (moderate public
  TTL as backstop), so a privatized object leaves the edge near-immediately.
- **Direct browser→S3 upload is in scope** — presigned PUT + multipart for large
  video, alongside server-mediated `PutObject` for generated assets.
- **Thumbnails inherit their parent asset** — same bucket, sibling key, no
  separate visibility flag; they move with the parent on reconcile.

---

## 1. The ported storage module

New directory `apps/api/src/lib/storage/` (cohesive, feature-named files per
`CLAUDE.md`/`AGENTS.md` conventions — no catch-all `index.ts`):

| File | Ported from / role |
|---|---|
| `config.ts` | env reader + validation (region, buckets, CloudFront, signing keys, `STORAGE_BACKEND`); same shape as `supabase/admin.ts` env reads |
| `s3-client.ts` | port of `s3Client.ts` — cached `S3Client`, region/endpoint/path-style resolution |
| `cloudfront.ts` | port of `cdn.ts` — `canSignCloudFront()`, `signCloudFrontUrl()` |
| `s3-presign.ts` | port of `s3Signing.ts` — presigned GET + parse-from-URL |
| `object-store.ts` | port of `storage.repository.ts` — `putObject`, `getObject`, `copyObject`, `deleteObject`, `objectUrl` (stable), `signedObjectUrl` (CloudFront→S3-presign→unsigned), `ensureBucket` |
| `asset-urls.ts` | **new** — `resolveAssetUrl(asset)` / `resolveAssetUrls(assets[])`, the one place that maps a row to a delivery URL (the adapted decision point) |
| `uploads.ts` | **new** — direct browser→S3 upload: mint presigned PUT / multipart-init + the `complete` finalizer that creates the asset row |
| `visibility-move.ts` | **new** — `reconcileAssetStorage()` (byte move, `storage_bucket` only) + `setAssetVisibility()` / `setProjectVisibility()` (flag change + reconcile; the project toggle preserves per-asset flags) |
| `local-store.ts` | the `STORAGE_BACKEND=local` implementation (disk), so the public interface is backend-agnostic |

`object-store.ts` and `local-store.ts` implement one small `ObjectStore`
interface so callers don't branch on backend.

Adaptations to the ported code:
- Replace harper's `coerceBucket`/`"contracts"` allow-list with our two logical
  buckets keyed on visibility.
- `resolveBucket(visibility)` → `assets-public` | `assets-private` (env-named).
- Convert `require()` → ESM imports.
- Drop harper's `PROJECT`/legacy-alias bucket naming.

---

## 2. Buckets, keys, and delivery model

```
assets-public   ──(origin)──►  CloudFront (public)   ──►  stable URL:  https://<cf-public-domain>/<key>
assets-private  ──(origin)──►  CloudFront (signed) OR S3 ──►  signed URL (≤ N min), per request
```

- **Key:** `{workspaceId}/{projectId}/{assetId}/{filename}` — identical in either
  bucket.
- **Public delivery:** `objectUrl(key)` = `S3_PUBLIC_URL_BASE` (the public
  CloudFront domain) + key. Unsigned, cacheable. The `assets-public` bucket is
  origin-locked to CloudFront via OAC (Origin Access Control); it is not
  world-listable, only fetch-by-key through the CDN.
- **Private delivery (chosen): S3 presigned GET** — `signedObjectUrl(key, ttl)`,
  default TTL 300s. The ported layer also supports CloudFront-signed delivery
  (private distribution + signing keys) as a later config-only upgrade if
  private re-fetch volume warrants; dev falls back to unsigned direct.

---

## 3. Write path (storing bytes)

Bytes reach a bucket two ways; both end at the same row shape — `storage_key` +
`storage_bucket` set, `url` left null.

**Common rule.** For a new asset, compute **effective visibility** (asset
visibility — from `defaultVisibilityForWorkspace` — AND its project's
visibility), pick `bucket = resolveBucket(effectiveVisibility)`, and use
`key = {ws}/{proj}/{assetId}/{filename}` with `ContentType` set. The DB tier
trigger still guarantees a free-owned workspace can only ever land in
`assets-public`.

**(a) Server-mediated** (generated-asset pipeline, small uploads): the API holds
the bytes and calls `putObject(bucket, key, bytes, contentType)`, then persists
`storage_key`/`storage_bucket`.

**(b) Direct browser→S3** (user uploads, incl. large video) — *in scope*:

1. Client calls `POST .../assets/upload-url` with
   `{ filename, contentType, size, visibility? }`. The API authorizes the
   project, reserves an `assetId`, computes the target bucket from effective
   visibility, and mints a **presigned PUT** scoped to that exact `key` — or,
   for large files, **initiates a multipart upload** and presigns the parts —
   returning the URL(s). The bucket is itself a guard: a free/public project can
   only ever be handed a presigned PUT into `assets-public`.
2. Client uploads bytes **directly to S3** (no API byte path; sidesteps the
   Railway request/memory limits that server-mediated upload of large video
   would hit).
3. Client calls `POST .../assets/:assetId/complete` (with multipart ETags if
   applicable); the API verifies the object exists, then finalizes the asset row
   (`status=ready`, `storage_key`, `storage_bucket`, visibility).

`remote_url` assets are unchanged (passthrough; not copied into our buckets in
this scope).

> `addAsset()` already stamps visibility; this scope adds the byte upload +
> `storage_bucket` write alongside it.

---

## 4. Read path (deriving URLs)

A single resolver, used everywhere a media URL is returned:

```
resolveAssetUrl(asset):
  if asset.remoteUrl: return asset.remoteUrl          # passthrough
  if not asset.storageKey: return null
  if asset.storageBucket == PUBLIC_BUCKET: return objectUrl(storageKey)        # stable
  else:                                    return signedObjectUrl(storageKey)  # short-lived
```

Wire `resolveAssetUrl` into the payload builders that currently leave URLs
unresolved:
- workspace asset list (`store.ts` mapAsset → add resolved `url`/`thumbnailUrl`)
- discovery (`listPublicProjects` / `listPublicAssets` / `searchPublicContent`)
  — these are public by definition, so they always resolve to stable URLs
- run outputs / dashboard `Outputs` payloads (playback URL)

Because discovery rows are always effective-public, they get cacheable URLs with
no per-request signing cost — the intended growth/scale property.

---

## 5. Visibility changes — flag vs. storage, and the cascade

Two distinct things change, and conflating them is a trap (raised in PR review):

- **The `visibility` *flag*** on a row is **user intent** ("I want this asset
  public"). It is changed *only* by an explicit toggle of *that* row.
- **`storage_bucket`** tracks **effective** visibility (where the bytes must
  physically live). It is reconciled whenever effective visibility changes —
  including when a *project* toggle changes an asset's effective state *without*
  touching the asset's own flag.

The byte-move primitive operates on `storage_bucket` only — never the flag:

```
reconcileAssetStorage(asset, project):
  effective = asset.visibility == 'public' AND project.visibility == 'public'
  want      = effective ? PUBLIC_BUCKET : PRIVATE_BUCKET
  if asset.storage_bucket == want: return                       # nothing to do
  copyObject(asset.storage_bucket → want, key)                  # same key
  UPDATE assets SET storage_bucket = want WHERE id = asset.id    # flag UNTOUCHED
  deleteObject(old bucket, key)
```

- Order is **copy → update row → delete original** (settled): a mid-failure
  orphans a harmless source object (sweepable), never a row pointing at a
  deleted key.

**Asset-level toggle** — `setAssetVisibility(assetId, v)`: update the asset's
`visibility` flag (user-scoped client, so the DB tier trigger gates *acquiring*
privacy), then `reconcileAssetStorage`.

**Project-level toggle** — `setProjectVisibility(projectId, v)`: update the
project's `visibility` flag, then `reconcileAssetStorage` for **every** asset in
the project. This is the eager cascade, and it **leaves each asset's own
`visibility` flag intact**:

- project→private: every asset becomes effective-private → bytes move to
  `assets-private`; asset flags are remembered beneath the ceiling.
- project→public (re-publish): assets still flagged `public` become
  effective-public again (bytes move back to `assets-public`); assets the owner
  had individually marked `private` stay private. The prior effective-public set
  is restored exactly — which is impossible if the cascade had overwritten the
  flags.

Thin endpoints (full shapes belong to the endpoint scope; minimum to exercise):
- `PATCH /projects/:projectId/assets/:assetId` `{ visibility }` → `setAssetVisibility`
- `PATCH /projects/:projectId` `{ visibility }` → `setProjectVisibility` (eager
  reconcile of all its assets, flags preserved).

**CloudFront cache on privatize (resolved: invalidate).** After deleting a
public object, edge caches and any holder of the old stable URL can still fetch
a cached copy until TTL expiry. So the privatize path **issues a CloudFront
invalidation for the key** (a moderate public TTL is the backstop). Invalidation
cost is negligible because privatize is rare, and correctness beats the cost for
a privacy feature. This applies to both `setAssetVisibility(..,'private')` and
the per-asset moves inside a project-privatize cascade.

---

## 6. Config & environment

New env (read in `lib/storage/config.ts`, validated when `STORAGE_BACKEND=s3`):

| Env | Purpose |
|---|---|
| `STORAGE_BACKEND` | `s3` \| `local` (default `local`) |
| `AWS_REGION` | S3/CloudFront region |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | S3 credentials (or instance role on Railway) |
| `S3_PUBLIC_BUCKET` | `assets-public` bucket name |
| `S3_PRIVATE_BUCKET` | `assets-private` bucket name |
| `S3_PUBLIC_URL_BASE` | public CloudFront domain base for stable URLs |
| `CF_SIGN_KEY_PAIR_ID` | CloudFront signing key-pair id (private delivery) |
| `CF_SIGN_PRIVATE_KEY` | CloudFront signing private key (PEM; `\n`-normalized) |
| `AWS_ENDPOINT_URL_S3` | optional — LocalStack/MinIO endpoint for tests |
| `S3_FORCE_PATH_STYLE` | optional — `true` for LocalStack/MinIO |

`.env.example` and `docs/railway-deployment.md` updated accordingly.

**Infra provisioning (ops, tracked but not code):**
- Create `assets-public` (CloudFront + OAC, public read via CDN only, long TTL)
  and `assets-private` (private; signed access).
- Bucket CORS for the web origin (**required** — direct presigned-PUT/multipart
  upload is in scope; allow `PUT`/`POST` + the multipart headers from the web
  origin).
- Distribution domains → `S3_PUBLIC_URL_BASE`; signing key-pair → CF envs.

---

## 7. Migration / data backfill

**No schema migration** — `visibility`, `storage_key`, `storage_bucket` already
exist. Data backfill only:

- Per data-model §6, existing asset rows backfill to
  `storage_bucket = 'assets-private'` and move to public on first publish. In
  practice the asset set is near-empty pre-launch (no cloud upload path existed),
  so byte migration from `.local`/Supabase Storage is expected to be trivial; a
  one-off script (read `storage_key` → `putObject` into the right bucket → set
  `storage_bucket`) covers any that exist. Confirm volume before running.

---

## 8. PR breakdown (each independently shippable)

- **PR1 — Storage foundation (dark).** Add `@aws-sdk/client-s3`,
  `@aws-sdk/cloudfront-signer`, `@aws-sdk/s3-request-presigner`; port the four
  modules into `lib/storage/` (`config`, `s3-client`, `cloudfront`, `s3-presign`,
  `object-store`) + `local-store`; `STORAGE_BACKEND` flag. Unit tests against
  LocalStack/MinIO (or mocked SDK). Not yet wired into assets → **no behavior
  change.**
- **PR2 — Write path (server-mediated).** On asset create/generate, `putObject`
  to the effective-visibility bucket and set `storage_key`/`storage_bucket`.
  Backfill script for any existing rows.
- **PR3 — Direct browser→S3 upload.** `uploads.ts`: `POST .../assets/upload-url`
  (presigned PUT + multipart-init/presign-parts) and
  `POST .../assets/:id/complete`; bucket CORS for the web origin. Lets large
  video bypass the API byte path.
- **PR4 — Read path.** `asset-urls.resolveAssetUrl` + wire into workspace asset
  list, discovery, and run-output payloads. (Now the dashboard/discover actually
  show media.)
- **PR5 — Visibility toggle + eager cascade.** `visibility-move.ts`
  (`reconcileAssetStorage` + `setAssetVisibility`/`setProjectVisibility`) +
  `PATCH .../assets/:id` and `PATCH /projects/:id` visibility endpoints +
  CloudFront invalidation on privatize.
- **PR0/ops (parallel).** Provision buckets + CloudFront + envs in AWS/Railway;
  can precede PR3 going live but doesn't block PR1/PR2 landing dark.

---

## 9. Testing

- **Unit/integration** against **LocalStack or MinIO** via `AWS_ENDPOINT_URL_S3`
  + `S3_FORCE_PATH_STYLE=true` (the ported client supports endpoint override) —
  put/get/copy/delete, `objectUrl` shape, signed-URL fallback chain.
- **Visibility-move tests:** copy→update→delete ordering; mid-failure leaves an
  orphan source (not a dangling row); tier trigger rejects free→private at the DB.
- **Effective-visibility tests:** asset public but project private → served as
  private (signed), and project→private cascade moves the bytes.
- **Read-path tests:** public asset → stable URL (no signing); private →
  short-lived signed URL; `remote_url` passthrough unchanged.

---

## 10. Resolved decisions (from review)

The questions raised during scoping are now resolved:

1. **Privatize → invalidate.** On public→private, after deleting the public
   object, issue a **CloudFront invalidation** for the key (moderate public TTL
   as backstop). Privacy-correct; negligible cost since privatize is rare. (§5)
2. **Private delivery = S3 presigned GET first.** Simplest; the ported layer can
   upgrade to a signed CloudFront distribution later via config if private
   re-fetch volume warrants — not a rewrite. (§2, §4)
3. **Direct browser→S3 upload is in scope.** Presigned PUT + multipart for large
   video, alongside server-mediated `PutObject` for generated assets; buckets get
   CORS for the web origin. (§3, PR3)
4. **Thumbnails inherit their parent.** Same bucket, sibling key
   (`{ws}/{proj}/{assetId}/thumb.*`), no separate visibility flag; they move with
   the parent on reconcile. Revisit when the thumbnail pipeline lands. (§2/§3)

Remaining genuinely-open items live in adjacent scopes (billing→tier; discovery
& visibility UI; the consume/bookmark endpoints; attribution/licensing).
