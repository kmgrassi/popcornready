# Golden-rule auth-id audit (cutover PR **A6**)

Audit of every place in the codebase that uses, stores, or derives the **Supabase
auth user id** where it should instead use the **domain id** (`public.users.id`).

## The rule being audited

From [`../supabase-identity-and-rls.md`](../supabase-identity-and-rls.md) ("Golden
rule"):

> Never use the auth user id (`auth.uid()` / `auth.users.id`) in application code,
> app tables, API payloads, or business logic. App identity is always the domain
> id, `public.users.id`, obtained via `public.current_app_user_id()`.

The auth id may appear in **exactly two** places, both in the database:

1. RLS policies — and even there only the `public.users` own-row policy compares
   `auth_id = auth.uid()`; every other policy uses `current_app_user_id()` /
   `is_workspace_member()` / `is_workspace_admin()`.
2. The mapping/trigger functions that bridge auth → domain
   (`current_app_user_id()`, `handle_new_user`).

**A "violation"** is any code or data outside those two places that reads the
authenticated user's id (`supabaseUser.id`, the `sub` of a verified JWT, etc.) and
then **stores it, passes it across the API boundary, derives an identifier from
it, or compares it as if it were the app identity.** Application identity must
route through `public.users.id` via `current_app_user_id()`.

### Where the auth id flows today

The current `AUTH_MODE=supabase` path is:

```
bearer token
  → getSupabaseAuthUser(token)          // returns the Supabase auth user; .id == auth.uid()
  → workspaceIdForUser(user.id)         // derives ws_user_<auth_uid>
  → Actor.id = user.id                  // app actor identity == auth id
  → ensureWorkspace(ws_user_<auth_uid>) // persists the auth-id-derived workspace id
  → every store call keys on auth.workspaceId / auth.actor.id
```

So a single resolution leaks the auth id into the **workspace id**, the **actor
id**, the **idempotency scope**, and (transitively) every persisted
project/asset/job row, because they all key on `workspaceId`.

> **Layout note.** The roadmap (A6) names the offender as `src/lib/api/v1/auth.ts`,
> but the monorepo split (PRs #124/#129/#131) has already moved the server lib to
> `apps/api/src/...`. All file paths below reflect the post-split location.

---

## Findings

### F1 — `workspaceIdForUser` derives the workspace id from the auth user id

[`apps/api/src/lib/api/v1/auth.ts:45-47`](../../apps/api/src/lib/api/v1/auth.ts#L45)

```ts
function workspaceIdForUser(userId: string) {
  return `ws_user_${userId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}
```

Called at [`auth.ts:67`](../../apps/api/src/lib/api/v1/auth.ts#L67) with
`getSupabaseAuthUser(token).id` (= `auth.uid()`). The auth id is baked into a
persisted, business-logic identifier (the workspace id), which then flows into
the store and into the idempotency scope (F4). This is the canonical violation:
an `auth.uid()`-derived value used as the app's tenancy key.

- **Why it's a violation:** the workspace id is app/business data; it must not be
  derived from `auth.uid()`. Tenancy should resolve through the domain user
  (`current_app_user_id()` → `public.users.id`) and that user's
  `workspace_members` rows.
- **Recommended fix:** resolve the caller's `public.users.id` (via the RLS-scoped
  client + `current_app_user_id()`), then look up their workspace(s) through
  `public.workspace_members` (and `workspaces.owner_id`, now a domain id) instead
  of synthesizing `ws_user_<uid>`. Remove `workspaceIdForUser` entirely.
- **Fixable now or cutover-coupled?** **Track C-coupled.** The workspace id is
  read from / written to the `.local` JSON store (`ensureWorkspace`), and there is
  no `public.users` / `workspace_members` lookup in the app yet (no TS code calls
  `current_app_user_id()`). A correct fix needs the Postgres-backed foundation
  store (C1) + the auth middleware that yields `current_app_user_id()` (B2). Do
  **not** treat this as a one-line rename.

### F2 — `Actor.id` is set to the auth user id

[`apps/api/src/lib/api/v1/auth.ts:71`](../../apps/api/src/lib/api/v1/auth.ts#L71)

```ts
actor: { id: user.id, type: "user", email: user.email ?? null },
```

`user.id` is the Supabase auth user id. `Actor.id` is the app-level actor
identity surfaced to the rest of the request lifecycle (handler, idempotency,
any future provenance/"created_by" attribution).

- **Why it's a violation:** the app's notion of "who is acting" is keyed on
  `auth.uid()` rather than `public.users.id`.
- **Recommended fix:** set `actor.id = current_app_user_id()` (the caller's
  `public.users.id`). Keep `email` (it's fine to carry through from the auth
  user), but the identity field must be the domain id.
- **Fixable now or cutover-coupled?** **Track B / C-coupled.** Requires the auth
  middleware to resolve `public.users.id`. Once B2 exposes
  `current_app_user_id()` per request, this is a small change — but it depends on
  that plumbing existing.

### F3 — `getSupabaseAuthUser` is the only identity resolver (no domain-id mapping)

[`apps/api/src/lib/supabase/server.ts:48-56`](../../apps/api/src/lib/supabase/server.ts#L48)
and its call site
[`apps/api/src/lib/api/v1/auth.ts:66`](../../apps/api/src/lib/api/v1/auth.ts#L66).

```ts
export async function getSupabaseAuthUser(accessToken: string) {
  const { data, error } = await getUserScopedSupabase(accessToken).auth.getUser(accessToken);
  ...
  return data.user;   // data.user.id === auth.uid()
}
```

The helper itself is legitimate (verifying the JWT / obtaining the auth user is a
necessary bridge step). The violation is **upstream**: `resolveAuth` consumes
`data.user.id` directly as app identity (F1, F2) and there is **no helper that
maps the verified auth user to `public.users.id`**. Grep confirms zero
application references to `current_app_user_id` / `public.users` outside SQL.

- **Why it's a violation (by omission):** the bridge from auth id → domain id
  (the whole point of the golden rule) is missing in the app, so every consumer
  is forced to use the auth id.
- **Recommended fix:** add the mapping step — after `getSupabaseAuthUser`, query
  the user-scoped client for `current_app_user_id()` (e.g.
  `select public.current_app_user_id()`), and have `resolveAuth` return the
  domain id. `getSupabaseAuthUser` can stay; the auth id simply must not escape
  past this resolution layer.
- **Fixable now or cutover-coupled?** **Track B-coupled.** This is the
  harper-server middleware (B2): verify JWT → user-scoped RLS client
  (AsyncLocalStorage) → resolve `current_app_user_id()`. It can land partly
  independently of the store (C), but is the prerequisite for fixing F1/F2/F4.

### F4 — Idempotency scope is keyed on the auth-id-derived workspace id and actor id

[`apps/api/src/lib/api/v1/handler.ts:74`](../../apps/api/src/lib/api/v1/handler.ts#L74)

```ts
const scope = `${auth.workspaceId}:${auth.actor.id}:${req.method}:${req.nextUrl.pathname}`;
```

Both `auth.workspaceId` (= `ws_user_<auth_uid>`, F1) and `auth.actor.id`
(= `auth.uid()`, F2) are auth-id-derived and get persisted into
`idempotency.scope` rows in the store.

- **Why it's a violation:** the auth id is written into app data (the idempotency
  key scope) and used in business logic (dedupe matching).
- **Recommended fix:** none here directly — this fixes itself once F1/F2 route
  through `public.users.id`. Flagged so the scope string is re-verified after the
  upstream fix (and so existing `.local` idempotency rows keyed on the old
  `ws_user_<uid>` scope are understood to be invalidated by the change).
- **Fixable now or cutover-coupled?** **Track C-coupled** (downstream of F1/F2).

### F5 — Actor relay in the legacy v1 generation stack

[`apps/api/src/lib/v1/actor.ts:36-43`](../../apps/api/src/lib/v1/actor.ts#L36)

```ts
const auth = await resolveAuth(req);
return {
  actorId: auth.actor.id,     // = auth.uid() in supabase mode (F2)
  workspaceId: auth.workspaceId, // = ws_user_<auth_uid> (F1)
  isLocal: auth.isLocal,
};
```

`resolveActorFromRequest` forwards the auth-id-derived `actor.id` and
`workspaceId` into the older generation stack's `Actor`. It's a propagation of
F1/F2 into a second code path, not an independent root cause.

- **Why it's a violation:** same auth-id leakage, now into the generation stack's
  tenancy/identity.
- **Recommended fix:** no separate change — once `resolveAuth` returns domain ids
  (F1/F2/F3), this relay is automatically correct. Re-verify after the fix.
- **Fixable now or cutover-coupled?** **Track B/C-coupled** (downstream of
  F1/F2/F3).

### F6 — Stale auth-id docs: v1 migration comments **and** the seed ownership instruction

[`supabase/migrations/20260603000000_init_v1_model.sql:13-15`](../../supabase/migrations/20260603000000_init_v1_model.sql#L13),
[`:43-44`](../../supabase/migrations/20260603000000_init_v1_model.sql#L43),
[`supabase/seed.sql:5-8`](../../supabase/seed.sql#L5)

```sql
-- Ownership model: a workspace belongs to one Supabase auth user
-- (auth.ts maps user.id -> ws_user_<uid>). RLS keys every row to auth.uid()
...
comment on column workspaces.owner_id is
  'Supabase auth user that owns this workspace. Maps to auth.ts ws_user_<uid>...';
```

These comments (and the original `owner_id uuid references auth.users(id)` +
`owner_id = auth.uid()` policies in this file) describe the **old** model. The
later migration
[`20260603140000_create_workspace_members.sql`](../../supabase/migrations/20260603140000_create_workspace_members.sql#L32)
already **repointed** `workspaces.owner_id` to `public.users(id)` and rerouted the
`owns_*` helpers / policies onto `current_app_user_id()` (the "Resolved" note in
the RLS doc). So the live DB state is **compliant**; only the descriptive
comments and the `column comment` in the earlier migration are now misleading.

**`supabase/seed.sql:5-8` is the same stale model but operationally dangerous, not
cosmetic.** It still instructs operators to attach the seeded workspace by setting
`owner_id` to an `auth.users.id`:

```sql
-- To attach this workspace to a real account, set
-- owner_id to that user's auth.users.id.
```

After `20260603140000` repointed `workspaces.owner_id` to `public.users(id)`,
following this guidance will **violate the FK** (an `auth.users.id` is not a
`public.users.id`) or, if a colliding id happens to exist, **recreate the exact
auth-id/domain-id mixup this audit is about**. So seed.sql must instruct setting
`owner_id` to the owner's **`public.users.id`** (i.e. `public.users.id WHERE
auth_id = <auth uid>`).

- **Why it's a violation:** the migration comments are a soft (teaches-wrong-model)
  issue; the seed instruction is a hard one — an operator who follows it breaks or
  corrupts ownership.
- **Recommended fix:** documentation only — update the migration comment block /
  column comment to the domain-id model, and fix the `seed.sql` instruction to
  reference `public.users.id`. Do not rewrite the historical migration's executable
  SQL (migrations are immutable history); seed.sql is not a migration and can be
  edited freely.
- **Fixable now or cutover-coupled?** **Quick win** (doc edits). The migration
  comments are cosmetic; the seed.sql fix is low-effort but should actually be done
  since following it breaks the FK.

---

## Summary

**6 findings.** One true root cause (F1), one closely-related root cause (F2),
one gap-by-omission that unblocks the fix (F3), two downstream propagations
(F4, F5), and one stale-comment finding (F6).

### Quick wins vs cutover-coupled

| Finding | Type | Quick win? |
|---|---|---|
| F1 `workspaceIdForUser` → `ws_user_<auth_uid>` | Root cause | No — **Track C** (store) + **B** (auth middleware) |
| F2 `Actor.id = auth.uid()` | Root cause | No — **Track B** (needs `current_app_user_id()`); small once B2 lands |
| F3 missing auth→domain mapping helper | Gap / prerequisite | No — **Track B** (B2 middleware); the unblocker for F1/F2/F4/F5 |
| F4 idempotency scope keyed on auth id | Downstream of F1/F2 | No — resolves with F1/F2 (**Track C**) |
| F5 legacy generation-stack actor relay | Downstream of F1/F2 | No — resolves with F1/F2/F3 |
| F6 stale auth-id docs (migration comments **+** `seed.sql:5-8`) | Docs only | **Yes** — migration comments cosmetic; **seed.sql fix should be done** (following it breaks the FK) |

**Net:** the only standalone quick win is F6 (doc edits — including the `seed.sql`
ownership instruction, which is actively wrong post-repoint). Everything that
actually moves identity (F1–F5) is **coupled to the Track C store cutover and the
Track B auth middleware** — exactly as A6 anticipates ("switch to
`public.users.id` (part of Track C cutover)"). The real unit of work is: land the
B2 middleware that resolves `current_app_user_id()` → `public.users.id`, have
`resolveAuth` return the **domain id** (deleting `workspaceIdForUser`), and resolve
the workspace through `workspace_members` once the Postgres-backed store (C1)
exists. F4/F5 then fall out for free; F6 is an independent doc cleanup.

### False positives considered (legitimate auth-id usage — NOT violations)

- **`public.current_app_user_id()`** — `select id from public.users where
  auth_id = auth.uid()`
  ([`20260603130000_create_public_users.sql:61-68`](../../supabase/migrations/20260603130000_create_public_users.sql#L61)).
  This *is* the sanctioned bridge; using `auth.uid()` here is the whole point.
- **`handle_new_user` trigger** — matches/sets `auth_id = new.id`
  ([`:90-99`](../../supabase/migrations/20260603130000_create_public_users.sql#L90)).
  Mapping/trigger function — explicitly allowed.
- **`public.users` own-row policies** — `using (auth_id = auth.uid())`
  ([`:156-161`](../../supabase/migrations/20260603130000_create_public_users.sql#L156)).
  The single permitted RLS comparison against `auth.uid()`.
- **`getSupabaseAuthUser` / `getUserScopedSupabase`**
  ([`apps/api/src/lib/supabase/server.ts`](../../apps/api/src/lib/supabase/server.ts))
  — verifying the JWT and building the user-scoped client necessarily touches the
  auth user. Legitimate as a bridge step; the violation is only that its result
  (`user.id`) is consumed as app identity downstream (F1–F3), not the helper
  itself.
- **`workspace_members` / `owns_*` policies keyed on `current_app_user_id()`**
  ([`20260603140000_create_workspace_members.sql`](../../supabase/migrations/20260603140000_create_workspace_members.sql))
  — already domain-id based; compliant.
- **`AUTH_MODE=local` paths** (`LOCAL_ACTOR_ID = "local_dev"`, `ws_local_dev`) —
  hardcoded deterministic dev constants, not derived from any auth id. Not a
  violation.
- **`apps/api/src/lib/agent-api/runtime.ts`** (`actorId: LOCAL_ACTOR_ID`) — local
  constant only; hosted key-based auth throws "not implemented". No auth-id usage.
</content>
</invoke>
