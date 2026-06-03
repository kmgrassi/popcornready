# Supabase identity model & RLS conventions

**Read this before writing any migration, RLS policy, or query that touches users.**
The single most common bug in this codebase's data layer is comparing the wrong
id in an RLS policy. This doc exists to make the right choice obvious.

## The three identifiers (do not conflate them)

| Identifier | Lives in | What it is | Equals `auth.uid()`? |
|---|---|---|---|
| `auth.uid()` | `auth` schema (Supabase) | The **authenticated session's** auth-user id (`auth.users.id`) | — |
| `public.users.id` | our schema | The **app/domain user** id (its own `gen_random_uuid()`) | **No** |
| `public.users.auth_id` | our schema | Nullable link from the domain user to their auth user | Yes (when set) |

`public.users.id` is **not** the same as `auth.uid()`. They live in different
spaces. The bridge between them is `auth_id`.

## Why decoupled? (the part that trips people up)

We deliberately did **not** make `public.users.id = auth.uid()`. If we had, a
`public.users` row would require a matching `auth.users` row — making it
impossible to represent a user who **hasn't authenticated yet**.

We need pre-auth users. Example: inviting someone to a workspace who has no
account. So:

- A domain user can exist with `auth_id = NULL` (invited / not yet signed up).
- When they sign up, the `handle_new_user` trigger on `auth.users` **adopts**
  the pre-created row (matched by email) and sets `auth_id` — rather than
  creating a duplicate. New users with no invite get a fresh row.

This is the harper-server pattern. See `~/Desktop/repos/harper-server`.

## The mapping helper: `public.current_app_user_id()`

To go from the session (`auth.uid()`) to the domain user (`public.users.id`):

```sql
select id from public.users where auth_id = auth.uid()
```

That lookup is wrapped in a helper so every policy uses it consistently:

```sql
public.current_app_user_id()  -- returns the caller's public.users.id (or NULL)
```

It is **`SECURITY DEFINER`** on purpose: an RLS policy on table X that reads
`public.users` would otherwise re-enter `public.users`' own RLS and can recurse
or wrongly deny. Running as owner sidesteps that. It returns `NULL` for a caller
with no linked domain row (e.g. pre-auth), which makes dependent policies deny by
default — the safe outcome.

## Writing RLS policies: the rules

**Rule 1 — "is this my own `public.users` row?"** Compare `auth_id` to `auth.uid()`:

```sql
-- on public.users
using (auth_id = auth.uid())
```

**Rule 2 — "does this row belong to me?" on any OTHER app table** that stores a
domain user id (an FK to `public.users.id`, e.g. `user_id`, `owner_user_id`):
compare to `current_app_user_id()`, **never** `auth.uid()`:

```sql
-- on e.g. public.projects (owner_user_id references public.users.id)
using (owner_user_id = public.current_app_user_id())
```

**Rule 3 — never compare a domain id column to `auth.uid()` directly.**
`some_table.user_id = auth.uid()` is almost always a bug: `user_id` is a
`public.users.id`, `auth.uid()` is an auth id. They won't match.

```sql
using (user_id = auth.uid())            -- ❌ WRONG: different id spaces
using (user_id = public.current_app_user_id())  -- ✅ RIGHT
```

**Rule 4 — any helper that reads `public.users` (or another RLS table) from
inside a policy must be `SECURITY DEFINER`** with a fixed `search_path`, to avoid
RLS recursion. Follow `current_app_user_id()`.

**Rule 5 — server vs browser.**
- Server-side code uses the **service_role** key, which **bypasses RLS**. It is
  responsible for enforcing tenancy itself (e.g. filtering by workspace). Use it
  for trusted writes like creating invite rows (`auth_id = NULL`).
- The browser / signed-in client runs as `authenticated`, so **RLS is enforced**
  and `auth.uid()` is populated.

## Lifecycle reference

```
Invite (server, service_role):
  insert into public.users (email) values ('invitee@x.com');   -- auth_id NULL

Signup (Supabase auth → trigger handle_new_user):
  - email matches an unlinked row?  → UPDATE that row, set auth_id = new auth id
  - no match?                       → INSERT a new row with auth_id = new auth id

Querying as that user (RLS):
  auth.uid()                = their auth.users.id
  current_app_user_id()     = their public.users.id   (via auth_id = auth.uid())
```

## Gotchas

- `auth.uid()` is `NULL` outside an authenticated request — every `... = auth.uid()`
  policy then denies. Expected.
- Only **one** unlinked (`auth_id IS NULL`) row may exist per email — enforced by a
  unique index so signup adoption is unambiguous. Linked rows rely on
  `auth.users` for email uniqueness.
- For hot tables, prefer `(select auth.uid())` / `(select public.current_app_user_id())`
  in policies so Postgres evaluates the function once per statement, not per row.

## Known inconsistency to fix

The PR #125 schema (`workspaces.owner_id`) currently references **`auth.users`**
and its `owns_workspace()` / `owns_project()` helpers compare to **`auth.uid()`**,
predating `public.users`. Those should migrate to reference `public.users.id` and
use `current_app_user_id()`. Until then, be aware two identity conventions coexist:
the v1 model tables key on `auth.uid()`, while `public.users` and anything built
on it key on the domain id.
