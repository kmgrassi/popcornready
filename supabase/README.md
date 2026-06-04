# Supabase

Postgres schema, Storage, and RLS for Popcorn Ready. Migrations in `migrations/`,
applied with `supabase db push` (link first: `supabase link --project-ref <ref>`).

## ⚠️ Identity & RLS — read before writing a policy

There are **three different ids** and mixing them up is the #1 data-layer bug:

- `auth.uid()` — the auth session's id (`auth.users.id`).
- `public.users.id` — the app/domain user id (its **own** uuid). **Not** `auth.uid()`.
- `public.users.auth_id` — nullable link between the two (NULL = invited / pre-auth).

Quick rules:

- Own-row check on `public.users` → `auth_id = auth.uid()`.
- Any other table's domain user column (FK to `public.users.id`) →
  `= public.current_app_user_id()`, **never** `= auth.uid()`.
- Helpers reading `public.users` inside a policy must be `SECURITY DEFINER`
  (avoids RLS recursion).
- Server code uses the **service_role** key (bypasses RLS); the browser client
  enforces RLS.

Full explanation, examples, lifecycle, and gotchas:
**[`../docs/supabase-identity-and-rls.md`](../docs/supabase-identity-and-rls.md)**.
