# User Tiers & Content Visibility — Data Model Scope

## Objective

Introduce **free** and **paid** user tiers and a **public/private** visibility
model for all user content, with the tier governing what visibility is allowed:

- **Free users** — all of their content and assets are **public**. Public
  content is consumable and discoverable (browsable/searchable) by anyone. Free
  users cannot make anything private.
- **Paid users** — content and assets default to **private** and can be toggled
  public/private per item.

This document defines the **data model** only: tables, columns, ownership,
enforcement, the tier↔visibility constraint, downgrade semantics, the discovery
read path, and the storage/delivery split. It targets the **split architecture**
(Express API + Supabase, per the worktree `CLAUDE.md`), not the Next monolith. It
is upstream of UI, billing-provider, and endpoint-shape work, which get their own
scopes.

> **Identity prerequisite.** This feature touches users and adds RLS. Per
> `CLAUDE.md`, anything touching users must follow
> [docs/supabase-identity-and-rls.md](../supabase-identity-and-rls.md). The rules
> below comply: tier lives on `public.users`, and every policy keys on
> `public.current_app_user_id()` (the domain id) — never `auth.uid()` directly.

## Where this sits in the existing model

The data layer already has a clean, membership-based identity + ownership spine.
The relevant migrations:

- `20260603130000_create_public_users.sql` — `public.users` (domain identity),
  `auth_id` link to `auth.users`, `handle_new_user` adoption trigger,
  `current_app_user_id()`.
- `20260603140000_create_workspace_members.sql` — `workspace_members`
  (owner/admin/member), repoints `workspaces.owner_id` to `public.users.id`, and
  reroutes `owns_workspace()`/`owns_project()` onto membership +
  `current_app_user_id()`.
- `20260603000000_init_v1_model.sql` — `projects`, `assets`, briefs,
  compositions, timelines, jobs, generation_*; the v1 RLS policies
  (`projects_owner`, `assets_owner`, …) that now resolve via the rerouted
  helpers.
- `20260603000100_assets_storage_bucket.sql` — the **private** assets bucket
  (signed URLs only).

```
auth.users (Supabase Auth)
   └─(auth_id)─ public.users            domain identity; current_app_user_id() resolves it
        └─ workspace_members            (workspace_id, user_id, role)  ← access is membership
             └─ workspaces.owner_id     → public.users.id  (the tier-governing owner)
                  └─ projects.workspace_id        a "video creative effort"
                       ├─ assets.project_id       project-scoped asset pool (immutable)
                       └─ brief_versions, compositions, timelines, jobs, generation_runs…
```

RLS today is **single-tenant, membership-scoped**: every v1 policy walks a row
back to its workspace and checks membership via `owns_workspace()` /
`owns_project()` (both now `current_app_user_id()`-based). There is **no** tier
concept and **no** `visibility` column anywhere.

Three consequences drive the design:

1. **Cross-tenant read path.** Discovery means reading rows whose workspace you
   are *not* a member of. Postgres permissive policies OR-combine, so we **add**
   public-read `SELECT` policies alongside the existing owner policies — we do
   not rewrite the owner policies (§3.3).
2. **Tier is a user property** → it lives on `public.users`. Visibility rights
   for a workspace's content follow the **workspace owner's** tier
   (`workspaces.owner_id → public.users.tier`), resolved by a definer helper.
3. **Public bytes need a different delivery path** than private ones — stable
   cacheable URLs vs. short-lived signed URLs — so storage is part of this model,
   not an afterthought (§3.4).

> Alignment with [NORTH_STAR](../NORTH_STAR.md): the project stays the single
> container and assets stay an immutable, project-scoped pool. Visibility is
> **metadata on existing rows**, not a new store or a copy-on-share mechanic.

---

## 1. Users and their tier

`public.users` already exists and is created/adopted on signup by
`handle_new_user`. **Tier is a column on it — not a new mirror table.** (My
earlier draft proposed a `profiles` mirror of `auth.users`; that was wrong for
this codebase — it would reintroduce the auth-id coupling the identity model
deliberately avoids.)

```sql
create type user_tier as enum ('free', 'paid');

alter table public.users
  add column tier            user_tier   not null default 'free',
  -- provenance of the current tier, for support + downgrade messaging
  add column tier_source     text,            -- 'stripe' | 'manual' | 'grandfathered' | null
  add column tier_changed_at timestamptz not null default now();
```

Decisions:

- **Default `'free'`, set by the column default.** No new signup trigger is
  needed: `handle_new_user` already inserts/adopts the `public.users` row, and
  the backfill in the public-users migration already covers existing auth users —
  all of whom become `free` until billing says otherwise.
- **`tier` is the single source of truth** consulted by every visibility check.
  Billing (Stripe, etc.) is *out of scope here*: its only job is to flip
  `public.users.tier` and stamp `tier_source` / `tier_changed_at`. Keeps the
  model billing-provider-agnostic. (If we'd rather keep `public.users` lean,
  these three columns can instead be a `public.user_billing` 1:1 table; same
  semantics. Inline columns are simpler and assumed here.)
- **Tier is per user; a workspace inherits its owner's tier.** Content is
  workspace-scoped and a workspace can have multiple members, so visibility
  rights must key on a single user: the **owner**. A free owner's workspace
  cannot hold private content even if a paid member joins; a paid owner's
  workspace can, regardless of members' tiers.

Helper — resolves the tier of a workspace's owner (definer, to read
`public.users` from inside other tables' policies without RLS recursion, matching
`current_app_user_id()`):

```sql
create or replace function public.owner_tier(ws_id text)
returns user_tier
language sql stable security definer set search_path = public as $$
  select coalesce(u.tier, 'free')
  from public.workspaces w
  left join public.users u on u.id = w.owner_id   -- owner_id is a public.users.id
  where w.id = ws_id;
$$;
```

---

## 2. Content and asset ownership

No change to the ownership spine. "Content" spans two granularities, both already
workspace/project-scoped:

| Unit | Table | What it is | Discoverable unit? |
|------|-------|-----------|--------------------|
| **Project** | `projects` | one video creative effort (the "content") | **yes** — primary browse/search row |
| **Asset** | `assets` | a pooled media item (clip, image, audio, keyframe) | yes — individually consumable/remixable |

Ownership/access is unchanged: `asset.project_id → project.workspace_id`, and
access is **workspace membership** (`owns_workspace`/`owns_project`). The
tier-governing **owner** is `workspaces.owner_id → public.users.id`. We do **not**
add `owner_id` to assets or projects; the workspace already carries it, and tier
is resolved through it via `owner_tier()`.

Other project-scoped rows (`timelines`, `compositions`, `edit_graphs`,
`brief_versions`, `jobs`, `generation_runs`…) are **internal artifacts**, not
independently consumable content. They inherit their project's visibility for
read purposes (§3.3) and are never independently discoverable.

---

## 3. The visibility model

### 3.1 The columns

A two-state visibility enum on the two consumable units, plus the storage
location discriminator (§3.4):

```sql
create type visibility as enum ('public', 'private');

alter table public.projects add column visibility visibility not null default 'public';
alter table public.assets   add column visibility visibility not null default 'public';

-- which bucket physically holds the object (delivery is derived from this, §3.4)
alter table public.assets   add column storage_bucket text;

create index projects_visibility_idx on public.projects (visibility) where visibility = 'public';
create index assets_visibility_idx   on public.assets   (visibility) where visibility = 'public';
```

- Static column default is **`public`** — the safe fallback (a free user's forced
  state; worst case for a paid user is "I have to click private").
- The *effective* default a paid user experiences (private-by-default) is applied
  at creation time by the API (or a companion `before insert` trigger that reads
  `owner_tier()`); the static default cannot itself be tier-dependent.

### 3.2 Effective visibility (composition rule)

A private project must not leak its assets. An asset is publicly consumable only
when **both** it and its project are public:

```
effective_public(asset) := asset.visibility = 'public'
                        AND project.visibility = 'public'
```

So a paid user can make a whole project private (hides all its assets regardless
of their own flag), or keep a project public but mark individual assets private.
Project visibility is the **ceiling**; asset visibility can only narrow it.

This rule has a storage consequence: `storage_bucket` must track
`effective_public(asset)`, not the asset's own flag alone — see §3.4.

### 3.3 Enforcement — three layers, defense in depth

Enforced at the database first, so it holds regardless of which client writes.

**Layer 1 — RLS: add public-read `SELECT` policies (cross-tenant).** Postgres
permissive policies combine with **OR**, so we keep the existing owner policies
(`projects_owner`, `assets_owner`, … — which already grant members full access)
and simply **add** public-read SELECT policies. A definer helper mirrors the
codebase's recursion-avoidance pattern:

```sql
-- public test as a definer helper (avoids RLS recursion through projects)
create or replace function public.project_is_public(proj_id text)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.projects p
                 where p.id = proj_id and p.visibility = 'public');
$$;

-- projects: members already covered by projects_owner; add public read
create policy projects_public_read on public.projects
  for select to anon, authenticated
  using (visibility = 'public');

-- assets: add public read gated on EFFECTIVE visibility (asset + its project)
create policy assets_public_read on public.assets
  for select to anon, authenticated
  using (visibility = 'public' and public.project_is_public(project_id));
```

Internal artifact tables (`timelines`, `compositions`, …) get an analogous
`*_public_read` SELECT policy keyed on `project_is_public(project_id)`, so a
public project's timeline is viewable but a private project's is not. **Writes are
untouched** — only members can write, via the existing owner policies.

> `to anon, authenticated` makes public content visible to logged-out visitors.
> If discovery should be login-required, drop `anon`. Flagged in §7.

**Layer 2 — the tier constraint trigger (§4).** Guarantees free-owned workspaces
can never hold a private row and free→private transitions are rejected.

**Layer 3 — API layer.** The server talks to Supabase as the user-scoped client
for owner operations (RLS enforced), but discovery and any `service_role` path
**bypass RLS** and must filter `visibility = 'public'` (effective, for assets)
**in the query**. Server code must never return a non-member's private rows even
though `service_role` could read them.

### 3.4 Storage & delivery — decided: S3 + CloudFront, two-bucket

Public discovery needs **stable, cacheable** URLs; private assets need
**short-lived signed** URLs. We serve both from **AWS S3 behind CloudFront**,
**reusing the battle-tested storage layer from `harper-medical`** rather than
writing one. The reusable, AWS-SDK-only modules:

- `server/src/utils/aws/s3Client.ts` — cached, env-driven S3 client.
- `server/src/utils/cdn.ts` — CloudFront URL signing (`canSignCloudFront`,
  `signCloudFrontUrl`; env `CF_SIGN_KEY_PAIR_ID`, `CF_SIGN_PRIVATE_KEY`).
- `server/src/utils/s3Signing.ts` — S3 presigned-GET fallback.
- `server/src/api/storage/storage.repository.ts` — upload + URL orchestration
  (`objectUrl`, `getSignedFileUrl`).

That layer already separates the two URL kinds we need: `objectUrl()` builds a
**stable, unsigned, cacheable** URL (with `S3_PUBLIC_URL_BASE` = our CloudFront
domain), and `getSignedFileUrl()` **resolves a signed URL on demand**
(CloudFront-signed → S3-presigned → fallback). This realizes the decouple: the
row stores *where the object is* (`storage_key` + `storage_bucket`), and the
served URL is **derived at read time** — never a baked, expiring URL in the DB.

**Two buckets — visibility is where the bytes live** (chosen over one-bucket
prefixes for strongest isolation: public-ness is a property of the bucket, hard
to leak by accident):

- **`assets-public`** — public-read, fronted by CloudFront → stable cacheable URL.
- **`assets-private`** — private origin → reads go through short-lived signed URLs.

**Adaptation to the ported layer (small):** harper keys public-vs-signed off the
bucket/location (`"contracts"` is its hardcoded public exception). We key it off
**`effective_public(asset)`** / the asset's `storage_bucket` — a one-function
change in `getSignedFileUrl()`.

**Visibility toggle — the one piece harper doesn't have; we build it.** Flipping
visibility moves the object across buckets and updates the row as one logical op:

```
toggle to public:   CopyObject   assets-private/<key> → assets-public/<key>
                    UPDATE assets SET visibility='public', storage_bucket='assets-public'
                    DeleteObject assets-private/<key>      -- after the row update
toggle to private:  the reverse
```

Order **copy → update-row → delete-original**, so a mid-failure leaves a harmless
orphaned source object (reconcilable by a sweep) rather than a row pointing at a
deleted key. The tier trigger (§4) still gates *acquiring* privacy; free-owned
workspaces can only ever trigger the →public direction.

**Effective-visibility cascade.** Because a public-bucket object is fetchable by
anyone holding its URL, the `effective_public` rule means **a project going
private must move its public assets into `assets-private`** — otherwise bytes
stay reachable though the DB says private. So `storage_bucket` tracks
`effective_public(asset)`. **Decided: eager cascade** — project→private moves its
public assets to `assets-private` as part of the toggle (a bounded burst of
server-side S3 copies; project-privatize is rare, so correctness beats saving the
copies). Lazy move-on-next-read was rejected as more moving parts for a rare op.

> Not a hard AWS lock-in: R2 speaks the S3 API, so `s3Client.ts`/`s3Signing.ts`
> port later if egress ever bites; only CloudFront-signing is AWS-specific.

---

## 4. How tier constrains visibility

The rule: **free-owned workspaces cannot hold private content; paid-owned default
private and may toggle.** Enforced by a trigger so it's true for every writer.

```sql
create or replace function public.enforce_visibility_tier()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.owner_tier(new.workspace_id) = 'free' and new.visibility = 'private' then
    -- Free owners may never SET a row to private. Existing private rows from a
    -- prior paid period are left untouched — this only fires when NEW is private.
    raise exception 'free tier cannot make content private (workspace %)', new.workspace_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger projects_visibility_tier
  before insert or update of visibility, workspace_id on public.projects
  for each row execute function public.enforce_visibility_tier();

create trigger assets_visibility_tier
  before insert or update of visibility, workspace_id on public.assets
  for each row execute function public.enforce_visibility_tier();
```

Behavior:

- **Free-owned content** → any insert/update to `private` is rejected; everything
  is `public`. ✔ "free content can't be made private."
- **Paid-owned content** → API (or a companion `before insert` default trigger)
  sets `visibility = 'private'` when `owner_tier() = 'paid'` and the caller didn't
  specify; individual items flip `public`/`private`.
- **`private → public` is always allowed**, any tier. Only *acquiring* privacy is
  gated.

### 4.1 Downgrade: what happens to a paid user's private content

When a paid owner downgrades (`public.users.tier: paid → free`), they own private
rows a free owner is not "allowed" to have. **Auto-publishing them would be a
serious privacy violation.** So the model is **retain-private-but-frozen**, which
the trigger already produces:

- **Existing private rows stay private and remain member-readable.** The trigger
  only fires when the *new* value is `private`; it never force-flips existing
  rows, and RLS still lets members read their workspace's rows regardless of tier.
  They remain excluded from discovery (they're private).
- **No new private content.** While free, any insert/update to `private` is
  rejected — frozen at the current private set.
- **The only way "out" of a private row while free is to publish it**
  (`private → public`, always allowed) — explicit and user-initiated, never
  automatic. (Publishing also triggers the bucket move, §3.4.)
- **Re-upgrading restores full control** with the private set intact.

Lossless and non-surprising: nothing marked private is exposed without an
explicit click, and the private library survives a downgrade.

> `tier_source` / `tier_changed_at` on `public.users` give support + UI enough to
> message this. A grace-period variant (keep paid powers N days post-cancel) is a
> `tier_changed_at` comparison, not a schema change.

Rejected alternatives (so we don't relitigate): **auto-publish on downgrade**
(privacy violation), **hard-delete** (destroys data over a billing state),
**hide from the owner too** (owner loses their own data). Frozen ≠ inaccessible
to members.

---

## 5. Discovery (public content from other users)

Discovery is a **cross-tenant read** over effective-public rows. The
`*_public_read` policies (§3.3) make these rows readable; discovery is the API +
indexing on top.

### 5.1 Read path

A new, membership-agnostic read surface (endpoint shapes in a later scope), e.g.:

- `GET /discover/projects` — paginated feed of public projects across all
  workspaces, newest-first, filterable.
- `GET /discover/assets` — effective-public assets (for remix/consume),
  filterable by `kind` / role.
- `GET /discover/search?q=…` — text search over public content.

These bypass the per-workspace scoping the owner read paths apply. They must
filter `visibility = 'public'` (effective, for assets) **in the query** — under
`service_role`, RLS won't catch a mistake.

### 5.2 What's searchable

Reuses content the model already carries:

- **Projects**: `name`, brief-derived text (`brief` jsonb — title/summary).
- **Assets**: `description`, plus the rich `context` jsonb from ingestion
  (`context.summary`, `recommendedRoles`, `transcriptText`, `moments[]`) and
  `semantic_analysis` — a strong, already-populated corpus.

```sql
create index projects_public_feed_idx on public.projects (created_at desc) where visibility = 'public';
create index assets_public_feed_idx   on public.assets   (created_at desc) where visibility = 'public';

create index projects_search_idx on public.projects
  using gin (to_tsvector('english', coalesce(name,'') || ' ' || coalesce(brief->>'summary','')))
  where visibility = 'public';
create index assets_search_idx on public.assets
  using gin (to_tsvector('english', coalesce(description,'') || ' ' || coalesce(context->>'summary','')))
  where visibility = 'public';
```

(Exact tsvector weighting is an impl detail; a generated `search_tsv` column is a
reasonable refinement.)

### 5.3 Consumption — copy-on-add-to-project (+ thin bookmark)

Decided: **consuming a public asset copies it, lazily, at the moment B adds it to
one of B's projects** — not while browsing. Discovery is the browse surface;
"add to project" is the single trigger that copies.

**Consume operation** (B adds public asset `X` to B's project `P`):

1. **Stale guard** — re-validate `effective_public(X)` and that `X` still exists.
   If A privatized or deleted it since the feed was rendered, reject ("no longer
   available") and create nothing — no dangling copy.
2. **Server-side S3 copy** — `CopyObject` `X`'s object → B's bucket (no
   download/re-upload; fast even for video; a `pending` status covers large files).
3. **New pooled asset** in `P` — `provenance.sourceAssetId = X` (+ source
   workspace/user for attribution). Visibility follows **B's** tier default (free
   B → public, paid B → private); A's visibility does not constrain B's copy.
4. **Selection** in `P` points at the new asset id.

The copy is durable — it survives A later privatizing or deleting `X`.

**Bookmark (save-for-later) — a thin, decoupled pointer that does NOT copy.** A
personal shortlist, orthogonal to the copy path:

```sql
create table public.saved_assets (
  user_id         uuid not null references public.users (id)  on delete cascade,
  source_asset_id text not null references public.assets (id) on delete cascade,
  created_at      timestamptz not null default now(),
  primary key (user_id, source_asset_id)
);
alter table public.saved_assets enable row level security;
create policy saved_assets_own on public.saved_assets
  for all to authenticated
  using (user_id = public.current_app_user_id())
  with check (user_id = public.current_app_user_id());
```

Rendering a bookmark reuses `X`'s public CDN URL (read-only, same as the feed);
adding a bookmarked asset to a project runs the exact consume operation above.
**Staleness is handled in two layers, no background sweep:** the `on delete
cascade` FK drops bookmarks when A **deletes** `X`, and a render-time
`effective_public` filter hides/flags bookmarks when A **privatizes** `X`.

**Still open:** attribution/licensing policy — what (if anything) a creator is
owed when their public content is copied, and any opt-out — rides on
`provenance.sourceAssetId` and is left to a productization scope.

---

## 6. Migration summary

A single migration (`supabase/migrations/2026XXXXXXXXXX_user_tiers_visibility.sql`)
adds, in order:

1. `user_tier` enum + `tier` / `tier_source` / `tier_changed_at` columns on
   `public.users` (default `free`). No new signup trigger — `handle_new_user` +
   the existing backfill already populate rows.
2. `owner_tier(ws_id)` helper (definer).
3. `visibility` enum + `visibility` column on `projects` and `assets`, +
   `storage_bucket` on `assets`, + partial indexes.
4. `project_is_public(proj_id)` helper + `*_public_read` SELECT policies on
   `projects`, `assets`, and the project-scoped artifact tables (added alongside
   the existing owner policies — permissive OR-combine; owner writes untouched).
5. `enforce_visibility_tier()` + triggers on `projects` and `assets`.
6. Discovery feed + search indexes.
7. `saved_assets` bookmark table + own-row RLS.

**Infra, handled in the implementation PR (not this migration):** create the
`assets-public` / `assets-private` buckets + CloudFront distributions, port the
four `harper-medical` storage modules, and build the cross-bucket toggle/cascade
(§3.4).

Per the no-legacy-compat principle, this is a forward cutover on the split
target. Existing rows backfill to `visibility = 'public'` (column default) and
`tier = 'free'` — correct until billing assigns tiers; existing asset objects are
backfilled to `storage_bucket = 'assets-private'` (today's private bucket) and
move to public on first publish.

## 7. Decisions & remaining scope

One genuinely open item remains, deferred (not blocking the data model):

- **Attribution/licensing** *(productization scope)*: what (if anything) a
  creator is owed when their public content is copied, + any opt-out — rides on
  `provenance.sourceAssetId` (§5.3).

_Resolved during scoping:_

- **Identity/tier** — tier on `public.users` via inline `tier` / `tier_source` /
  `tier_changed_at` columns (not a `profiles` mirror, not a separate billing
  table); visibility rights follow the **workspace owner's** tier (§1).
- **Storage/delivery** — S3 + CloudFront, two buckets
  (`assets-public` / `assets-private`), reusing the `harper-medical` layer;
  visibility toggle = cross-bucket copy + delete (§3.4).
- **Effective-visibility cascade** — **eager**: project→private moves its public
  assets to `assets-private` as part of the toggle (§3.4).
- **Consumption** — copy-on-add-to-project + a thin `saved_assets` bookmark
  (§5.3).
- **Downgrade** — **immediate freeze** (retain-private-but-frozen); an N-day
  grace is a later `tier_changed_at` tweak, no schema change (§4.1).
- **Anonymous discovery** — **allowed**: the public feed is readable by `anon`
  (the growth surface for a free-public product); `*_public_read` grants to
  `anon, authenticated` (§3.3).
