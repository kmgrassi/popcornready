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
enforcement, the tier↔visibility constraint, downgrade semantics, and the
discovery read path. It is deliberately upstream of UI, billing-provider, and
endpoint-shape work, which get their own scopes.

## Where this sits in the existing model

The v1 schema (`supabase/migrations/20260603000000_init_v1_model.sql`) already
has a clean ownership spine that this feature extends rather than replaces:

```
auth.users (Supabase Auth)
   └─ workspaces.owner_id           one workspace per auth user (ws_user_<uid>)
        └─ projects.workspace_id    a "video creative effort"
             ├─ assets.project_id   project-scoped asset pool (immutable, never deleted)
             ├─ brief_versions, compositions, timelines, edit_graphs, jobs, generation_runs…
```

RLS today is **pure single-tenant ownership**: every policy walks a row back to
its workspace and checks `owner_id = auth.uid()` via the `owns_workspace()` /
`owns_project()` helpers. There is **no** users-profile table, **no** tier/plan
concept, and **no** `visibility` column anywhere. The asset bucket
(`20260603000100_assets_storage_bucket.sql`) is **private**; the browser only
ever sees server-minted signed URLs.

Two consequences drive the design below:

1. We must add a **cross-tenant read path** — discovery means reading rows whose
   workspace you do *not* own. That is a new RLS shape (public-read policies),
   not just a new column.
2. **Owner = workspace owner = the auth user.** Tier is a property of the
   *user*, so it lives next to `auth.users`, and visibility is enforced by
   looking up the owning user's tier. No per-asset owner is introduced; the
   existing `workspace_id → owner_id` chain already identifies the owner.

> Alignment with [NORTH_STAR](../NORTH_STAR.md): the project stays the single
> container and assets stay an immutable, project-scoped pool. Visibility is
> **metadata on existing rows**, not a new store or a copy-on-share mechanic.

---

## 1. Users and their tier

There is no users table today (identity is `auth.users` only). Add a **profile
mirror** of `auth.users` to hold the tier — the same `auth.users` mirror +
RLS pattern used in the harper-server reference, without legacy auth-id
indirection.

```sql
create type user_tier as enum ('free', 'paid');

create table profiles (
  id               uuid       primary key references auth.users (id) on delete cascade,
  tier             user_tier  not null default 'free',
  -- provenance of the current tier, for support/debugging and downgrade logic
  tier_source      text,            -- 'stripe' | 'manual' | 'grandfathered' | null
  tier_changed_at  timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
```

Decisions:

- **One row per auth user, created on signup.** A Supabase `auth` trigger
  (`on auth.users insert`) inserts a `profiles` row with `tier = 'free'`. Users
  without a profile row are treated as free (defensive default).
- **`tier` is the single source of truth** consulted by every visibility check.
  Billing (Stripe, etc.) is *out of scope here*: whatever the billing system is,
  its only job is to flip `profiles.tier` and stamp `tier_source` /
  `tier_changed_at`. This keeps the data model billing-provider-agnostic.
- **Tier is per user, not per workspace.** Today it's 1:1 anyway
  (`ws_user_<uid>`), but anchoring tier to the user keeps it correct if a user
  ever owns multiple workspaces.

Helper used by enforcement and RLS — resolves the tier of a workspace's owner:

```sql
create or replace function owner_tier(ws_id text)
returns user_tier
language sql stable security definer set search_path = public as $$
  select coalesce(p.tier, 'free')
  from workspaces w
  left join profiles p on p.id = w.owner_id
  where w.id = ws_id;
$$;
```

---

## 2. Content and asset ownership

No change to the ownership spine. "Content" in this product spans two
granularities, both already workspace/project-scoped:

| Unit | Table | What it is | Discoverable unit? |
|------|-------|-----------|--------------------|
| **Project** | `projects` | one video creative effort (the "content") | **yes** — primary browse/search row |
| **Asset** | `assets` | a pooled media item (clip, image, audio, keyframe) | yes — individually consumable/remixable |

Ownership is unchanged: `asset.project_id → project.workspace_id →
workspace.owner_id → auth.users.id`. We do **not** add `owner_id` to assets or
projects; the workspace already carries it. Tier is looked up through that
chain via `owner_tier()`.

Other project-scoped rows (`timelines`, `compositions`, `edit_graphs`,
`brief_versions`, `jobs`, `generation_runs`…) are **internal artifacts**, not
independently consumable content. They inherit their project's visibility for
read purposes (see §3) and are never independently discoverable.

---

## 3. The visibility model

### 3.1 The column

A two-state visibility enum on the two consumable units:

```sql
create type visibility as enum ('public', 'private');

alter table projects add column visibility visibility not null default 'public';
alter table assets   add column visibility visibility not null default 'public';

create index projects_visibility_idx on projects (visibility) where visibility = 'public';
create index assets_visibility_idx   on assets   (visibility) where visibility = 'public';
```

- Static column default is **`public`** — the safe fallback (a free user's
  forced state, and the worst case for a paid user is "I have to click private").
- The *effective* default a paid user experiences (private-by-default) is
  applied at creation time by the API / a trigger that reads `owner_tier()`
  (see §4). The static default cannot itself be tier-dependent.

### 3.2 Effective visibility (composition rule)

A private project must not leak its assets. So an asset is publicly consumable
only when **both** it and its project are public:

```
effective_public(asset) := asset.visibility = 'public'
                        AND project.visibility = 'public'
```

This means a paid user can:

- Make a whole project private → all its assets are hidden regardless of their
  own flag.
- Keep a project public but mark **individual assets** private (e.g. a public
  montage that hides one raw source clip).

Project visibility is the **ceiling**; asset visibility can only narrow, never
widen, the project's exposure.

### 3.3 Enforcement — three layers, defense in depth

Visibility is enforced at the database first, so it holds regardless of which
client or code path writes the row.

**Layer 1 — RLS read policies (cross-tenant public read).** This is the new
capability. Replace the owner-only `select` with: *owners see everything they
own; anyone (incl. `anon`) sees public rows.*

```sql
-- projects: owner sees all theirs; everyone sees public ones
create policy projects_read on projects
  for select using (owns_workspace(workspace_id) or visibility = 'public');

-- assets: owner sees all theirs; everyone sees assets that are public
--         AND whose project is public (effective visibility)
create policy assets_read on assets
  for select using (
    owns_workspace(workspace_id)
    or (visibility = 'public'
        and exists (select 1 from projects p
                    where p.id = assets.project_id and p.visibility = 'public'))
  );

-- writes stay owner-only (unchanged shape)
create policy projects_write on projects
  for all using (owns_workspace(workspace_id)) with check (owns_workspace(workspace_id));
create policy assets_write on assets
  for all using (owns_workspace(workspace_id) and owns_project(project_id))
  with check (owns_workspace(workspace_id) and owns_project(project_id));
```

> Note: splitting the old `for all` policy into `select` (public-aware) +
> non-select write policies is required — a single `for all` policy would
> expose public rows to writes too. Internal artifact tables
> (`timelines`, `compositions`, …) get an analogous read policy that walks to
> the project's visibility, so a public project's timeline is viewable but its
> private project's is not.

**Layer 2 — the tier constraint trigger (see §4).** Guarantees free users can
never hold a private row and free→private transitions are rejected.

**Layer 3 — API layer.** `store-supabase.ts` query helpers and the discovery
endpoints apply the same predicates explicitly (so behavior is identical under
the `service_role` key, which **bypasses RLS**). Server code must never return
private rows of a non-owner even though the service key *could* read them.

### 3.4 Storage implications

The assets bucket is currently **private** (signed URLs only). Public,
discoverable assets need URLs that anyone can fetch and that a CDN can cache —
signed URLs (short-lived, per-user) don't fit discovery. Options, to settle in
the implementation scope:

- **(a)** A second **public** storage bucket; public assets' objects live (or
  are copied) there, private assets stay in the private bucket. Moving an asset
  private↔public moves/copies the object.
- **(b)** Keep one bucket, mint **long-lived unsigned public URLs** for
  effective-public assets and signed URLs otherwise.

This is the one place visibility is more than a column flip; flag it as a
dependency, not a blocker for the data-model migration.

---

## 4. How tier constrains visibility

The rule: **free users cannot hold private content; paid users default private
and may toggle.** Enforced by a trigger so it's true for every writer.

```sql
create or replace function enforce_visibility_tier()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- Resolve owner tier for the row's workspace.
  if owner_tier(new.workspace_id) = 'free' then
    -- Free owners may never SET a row to private.
    -- (Existing private rows from a prior paid period are left untouched —
    --  the guard only fires when the new value is 'private'.)
    if new.visibility = 'private' then
      raise exception 'free tier cannot make content private (workspace %, owner is free)',
        new.workspace_id
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

create trigger projects_visibility_tier
  before insert or update of visibility, workspace_id on projects
  for each row execute function enforce_visibility_tier();

create trigger assets_visibility_tier
  before insert or update of visibility, workspace_id on assets
  for each row execute function enforce_visibility_tier();
```

Behavior this produces:

- **Free user creates content** → any attempt to insert/set `private` is
  rejected; everything they own is `public`. ✔ "free content can't be made
  private."
- **Paid user creates content** → API (or a companion `before insert` default
  trigger) sets `visibility = 'private'` when `owner_tier() = 'paid'` and the
  caller didn't specify; they can flip individual items to `public` and back.
- **`private → public` is always allowed**, for any tier. Only the *acquisition*
  of privacy is gated.

### 4.1 Downgrade: what happens to a paid user's private content

When a paid user downgrades to free (`profiles.tier: paid → free`), they own
private rows that a free user is not "allowed" to have. **Auto-publishing them
would be a serious privacy violation** — silently exposing content the user
chose to keep private. So the model is **retain-private-but-frozen**, which the
trigger above already produces for free:

- **Existing private rows stay private and remain owner-readable.** The trigger
  only fires when the *new* value is `private`; it never force-flips existing
  rows, and RLS still lets the owner read their own rows regardless of tier.
  They remain excluded from discovery (they're private).
- **No new private content.** While free, any insert/update to `private` is
  rejected — the account is effectively frozen at its current private set.
- **The only way "out" of a private row while free is to publish it**
  (`private → public`, always allowed) — an explicit, user-initiated action,
  never automatic.
- **Re-upgrading restores full control** with the private set intact.

This makes downgrade *lossless and non-surprising*: nothing the user marked
private is ever exposed without their explicit click, and their private library
is preserved for when/if they return to paid.

> `tier_source`/`tier_changed_at` on `profiles` give support and UI enough to
> message this ("you have N private items frozen by your downgrade — re-upgrade
> to edit, or publish them"). A future grace-period variant (keep paid powers
> for N days post-cancel) is a `tier_changed_at` comparison, not a schema
> change.

Rejected alternatives (documented so we don't relitigate):

- **Auto-publish private content on downgrade** — privacy violation; rejected.
- **Hard-delete private content on downgrade** — destroys user data over a
  billing state change; rejected.
- **Hide private content from the owner too until re-upgrade** — owner loses
  access to their own data; rejected. (Frozen ≠ inaccessible to the owner.)

---

## 5. Discovery (public content from other users)

Discovery is a **cross-tenant read** over effective-public rows. The RLS
`select` policies in §3.3 already make these rows readable by `anon` and
`authenticated`; discovery is the API + indexing on top.

### 5.1 Read path

A new, owner-agnostic read surface (endpoint shapes in a later scope), e.g.:

- `GET /api/v1/discover/projects` — paginated feed of public projects across all
  workspaces, newest-first, filterable.
- `GET /api/v1/discover/assets` — public, effective-public assets (for
  remix/consume), filterable by `kind` and asset role.
- `GET /api/v1/discover/search?q=…` — text search over public content.

These bypass the per-user `workspace_id` scoping that the existing
`listProjects`/`listAssets` helpers in `store-supabase.ts` apply. They must
filter on `visibility = 'public'` (and effective-public for assets) **in the
query**, because server code runs under `service_role` and RLS won't catch a
mistake there.

### 5.2 What's searchable

Discovery indexes content the model already carries:

- **Projects**: `name`, and brief-derived text (`brief` jsonb — title, summary).
- **Assets**: `description`, plus the rich `context` jsonb already produced by
  ingestion (`context.summary`, `recommendedRoles`, `transcriptText`,
  `moments[]`) and `semantic_analysis`. This is a strong, *already-populated*
  search corpus.

Supporting indexes:

```sql
-- discovery feed ordering
create index projects_public_feed_idx on projects (created_at desc) where visibility = 'public';
create index assets_public_feed_idx   on assets   (created_at desc) where visibility = 'public';

-- full-text search (Postgres tsvector) over public project/asset text
create index projects_search_idx on projects
  using gin (to_tsvector('english', coalesce(name,'') || ' ' || coalesce(brief->>'summary','')))
  where visibility = 'public';
create index assets_search_idx on assets
  using gin (to_tsvector('english', coalesce(description,'') || ' ' || coalesce(context->>'summary','')))
  where visibility = 'public';
```

(Exact tsvector expression / weighting is an implementation detail; a generated
`search_tsv` column is a reasonable refinement.)

### 5.3 Consumption semantics (flag for later scope)

"Available for other users to consume" raises questions beyond this data model:
does consuming a public asset **copy it into the consumer's project pool** (new
`asset` row, `provenance` pointing at the source asset id) or **reference it in
place**? The asset-pool/provenance model favors **copy-with-provenance** —
consistent with "assets are immutable, relationships are by id" — but the
attribution/licensing rules are out of scope here. Noted so the visibility model
doesn't accidentally foreclose it: a `provenance.sourceAssetId` cross-workspace
reference is compatible with everything above.

---

## 6. Migration summary

A single migration (`supabase/migrations/2026XXXXXXXXXX_user_tiers_visibility.sql`)
adds, in order:

1. `user_tier` enum + `profiles` table + `on auth.users insert` → seed profile
   trigger.
2. `owner_tier(ws_id)` helper.
3. `visibility` enum + `visibility` column on `projects` and `assets` (default
   `public`) + partial indexes.
4. `enforce_visibility_tier()` + triggers on both tables.
5. Drop the old `*_owner for all` read behavior; add split `*_read` (public-aware
   `select`) + `*_write` (owner-only) policies on `projects`, `assets`, and the
   project-scoped artifact tables.
6. Discovery feed + search indexes.

Per the no-legacy-compat principle, this is a forward cutover: the old
owner-only `select` semantics are replaced, not shimmed. Existing rows backfill
to `visibility = 'public'` (the column default) — correct for current users, who
are all effectively "free" until billing assigns tiers.

## 7. Open decisions (need a call before implementation)

- **Storage**: public bucket vs. long-lived unsigned URLs (§3.4).
- **Consumption**: copy-into-pool vs. reference-in-place, + attribution/licensing
  (§5.3).
- **Downgrade messaging/grace**: immediate freeze (default here) vs. N-day grace
  via `tier_changed_at` (§4.1).
- **Tier granularity**: confirm tier is per-user (assumed) vs. per-workspace.
- **Anonymous discovery**: is public content browsable by logged-out visitors
  (`anon` role), or login-required? RLS above allows `anon`; tighten if not.
