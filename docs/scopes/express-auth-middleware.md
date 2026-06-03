# Express auth middleware (Track B2)

Spec for the request-auth middleware in the **future Express API package**
(`apps/api`), not the Next monolith. It ports the
[harper-server auth pattern](../../../harper-server/src/middleware/auth-readme.md)
and adapts it to our identity model.

> **Read first:** [`../supabase-identity-and-rls.md`](../supabase-identity-and-rls.md)
> — the Golden rule (the auth user id never leaves RLS), the three identifiers,
> and the `current_app_user_id()` mapping. This spec assumes that model and never
> exposes `auth.uid()` upward.

Roadmap context: Track **B2** in
[`supabase-cutover-prs.md`](./supabase-cutover-prs.md) (depends on E1 — the
Express API scaffold — and A2 — `public.users` decoupled from `auth.users`).

---

## 1. Goal & non-goals

**Goal.** On every authenticated request to the Express API:

1. Verify the caller's Supabase session.
2. Build a **user-scoped, RLS-enforced** Supabase client and make it available to
   all downstream code without threading it through every function.
3. Resolve and attach the caller's **domain id** (`public.users.id`) to the
   request context.
4. Reject unauthenticated/invalid requests with a consistent error envelope.

**Non-goals.**

- **Do not leak the auth id upward.** `auth.users.id` (`auth.uid()`) must never be
  attached to request context, returned in payloads, or used in business logic.
  Handlers see `publicUserId` (a `public.users.id`) only. The auth id stays inside
  Supabase/RLS, exactly as the Golden rule requires.
- **No RLS in app code.** Tenancy enforcement is the database's job via the
  user-scoped client. The middleware does not re-implement row filtering.
- **No login/signup/session UI** — that is Track B1 (the SPA). This middleware only
  *verifies* an already-issued session token.
- **No service_role for data reads.** service_role is reserved for the narrow
  trusted-ops surface in §3.
- **Not the Next monolith.** The monolith keeps its current `resolveAuth`
  (`src/lib/api/v1/auth.ts`) until the split is the deploy target.

---

## 2. Request flow

```
client request
  └─ Authorization: Bearer <access_token>
        │
        ▼
  authMiddleware
   1. extract bearer access token            → 403 if absent
   2. verify session (getUser(token))         → 401 if invalid/expired
   3. build USER-SCOPED client (anon key + caller's bearer token)
   4. resolve public.users.id for this auth user
                                              → 401 if no linked domain row
   5. run downstream inside AsyncLocalStorage:
        { supabase: userScopedClient, publicUserId, email }
        │
        ▼
  route handlers
   - getRequestClient()  → RLS-enforced Supabase client
   - getPublicUserId()   → caller's public.users.id
```

### 2.1 Token transport — recommend **bearer header**

**Recommendation: `Authorization: Bearer <access_token>`.** Reasons:

- It is what the app already does. The monolith's `resolveAuth`
  (`src/lib/api/v1/auth.ts`) and `getUserScopedSupabase`
  (`src/lib/supabase/server.ts`) already read a bearer access token, so the SPA
  and agent callers need no change in Track B3.
- The API is a separate origin (Railway) from the SPA (Netlify). Cross-site
  cookies require `SameSite=None; Secure` + strict CORS and bring CSRF surface;
  a bearer token sent explicitly by `fetch` sidesteps that.
- A pure SPA already holds the session in the Supabase JS client and can attach
  the token per request.

We deliberately **do not** copy harper-server's two-header
(`access_token` + `refresh_token`) transport. We send only the **access token**,
in the standard `Authorization` header, and verify it statelessly with
`getUser(token)` (see §2.2). Refresh is the SPA's job — see Open Questions.

> If we later adopt `@supabase/ssr` cookie sessions (see roadmap Open Questions),
> only the token-extraction step changes; everything below is transport-agnostic.

### 2.2 Verifying the session — `getUser`, not `setSession`

harper-server uses `supabase.auth.setSession({ access_token, refresh_token })` on
a **service_role** client. We diverge for two reasons: we only carry the access
token, and we want the *verifying* client to be the same **user-scoped** client we
hand downstream — so RLS is in force from the first query.

Build the user-scoped client by attaching the caller's token to an **anon-key**
client (mirrors `getUserScopedSupabase` in `src/lib/supabase/server.ts`), then
verify with `auth.getUser(token)`:

```ts
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  global: { headers: { Authorization: `Bearer ${accessToken}` } },
});
const { data, error } = await supabase.auth.getUser(accessToken);
```

`getUser(token)` validates the JWT against Supabase Auth and returns the auth
user. Because every PostgREST request from this client carries the same bearer
token, the request runs as role `authenticated` with `auth.uid()` populated — so
**RLS and `current_app_user_id()` apply automatically**. This is the crux: the
client we propagate is already tenant-scoped.

### 2.3 Resolving `public.users.id`

Two options; we **resolve once, explicitly, and cache on the request**:

- **Primary — RPC the mapping helper.** Call `current_app_user_id()` through the
  user-scoped client. It runs `select id from public.users where auth_id = auth.uid()`
  as `SECURITY DEFINER` and returns the domain id (or `NULL`):

  ```ts
  const { data: publicUserId } = await supabase.rpc("current_app_user_id");
  ```

  This is the single source of truth and guarantees the same value RLS uses in
  policies — no second interpretation of the auth→domain mapping in app code.

- **Alternative — `select id from public.users where auth_id = <auth user id>`.**
  Equivalent, but re-implements the mapping in app code and reads `public.users`
  under that table's own-row RLS. Prefer the RPC.

If the result is `NULL` (a verified auth user with **no** linked domain row — e.g.
a session that exists but whose `handle_new_user` adoption hasn't run, or a
pre-auth edge case) → **401** (mirrors harper-server returning 401 when
`getUserByAuthId` is empty). Downstream code can assume `publicUserId` is present.

> Even though policies could call `current_app_user_id()` themselves, we resolve it
> once in the middleware so handlers have the id for app logic (ownership checks,
> response shaping, logging) **without** ever touching the auth id.

### 2.4 Propagation via `AsyncLocalStorage`

Port harper's `supabaseStorage` AsyncLocalStorage so the client (and resolved id)
flow through the request without parameter threading. Run `next()` *inside* the
store so all async work in the request inherits it:

```ts
requestContext.run({ supabase, publicUserId, email }, next);
```

Downstream accessors (§5.2) read the current store. This is identical in spirit to
harper's `supabaseStorage.run(client, next)` /
`withRequestContext([...], next)`, narrowed to one store holding the user-scoped
client plus the domain id.

---

## 3. service_role vs user-scoped client

| | **User-scoped client** (default) | **service_role client** (trusted ops) |
|---|---|---|
| Key | anon key + caller bearer token | `SUPABASE_SERVICE_ROLE_KEY` |
| DB role | `authenticated`, `auth.uid()` set | `service_role` |
| RLS | **enforced** | **bypassed** |
| Tenancy | by RLS / `current_app_user_id()` | **must be enforced in code** |
| Source | request `AsyncLocalStorage` (this middleware) | a separate explicit factory; never request-default |

**Default to the user-scoped client for all request-driven data access.** RLS does
the tenant filtering; you cannot accidentally read another workspace's rows.

**service_role only for genuinely trusted operations** that must run outside the
caller's row visibility, e.g.:

- **Invites** (Track F) — inserting a `public.users` row with `auth_id = NULL` for
  someone who hasn't authenticated, and the matching `workspace_members` row. The
  caller can't see/insert that row under RLS, so this needs service_role — and the
  code must itself check the caller is an admin of the target workspace
  (`is_workspace_admin` semantics) before writing.
- **System / background jobs** — generation workers with no request session.

service_role is **never** the request default and **never** placed in the request
`AsyncLocalStorage`. Provide it via an explicit factory (e.g.
`getServiceRoleClient()`, configured in Track **C3**) that a handler must opt into,
and enforce tenancy in that code path. This matches Rule 5 in the identity doc
(server-side service_role bypasses RLS → it owns tenancy).

---

## 4. Error handling

Two distinct cases, plus a consistent envelope reusing the existing v1 shape
(`error: { code, message, requestId }`, see `src/lib/api/v1/responses.ts` /
`errors.ts`):

| Condition | Status | `code` | Notes |
|---|---|---|---|
| No bearer token present | **403** | `forbidden` | "missing credentials" — nothing to authenticate |
| Token present but invalid/expired (`getUser` errors / no user) | **401** | `unauthorized` | session rejected |
| Verified auth user but **no** linked `public.users` row (`current_app_user_id()` → NULL) | **401** | `unauthorized` | treat as unauthenticated; do not leak that the auth user exists |
| Supabase misconfigured (missing URL/keys) | **500** | `internal_error` | config bug, not a client error |

> We keep harper-server's 403-for-missing / 401-for-invalid split. (Note this is the
> inverse of the HTTP convention where 401 = unauthenticated and 403 = authorized
> but forbidden; we follow harper's convention for parity, and reserve 403 in the
> *app* layer for genuine authorization failures once a session exists.)

Envelope (identical to v1 errors so SPA error handling is uniform):

```json
{ "error": { "code": "unauthorized", "message": "Invalid or expired session.", "requestId": "..." } }
```

Log 4xx as warnings, 5xx as errors (as harper does). Messages stay generic — never
echo Supabase internals or reveal whether an auth user exists.

---

## 5. Interface sketch

Framework-accurate for Express + `@supabase/supabase-js`. Illustrative, not final.

### 5.1 Request context + AsyncLocalStorage

```ts
// auth/request-context.ts
import { AsyncLocalStorage } from "node:async_hooks";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface RequestContext {
  supabase: SupabaseClient;   // user-scoped, RLS-enforced
  publicUserId: string;       // public.users.id (domain id) — NEVER the auth id
  email: string | null;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();
```

### 5.2 Accessors used by handlers

```ts
// auth/accessors.ts
import { requestContext } from "./request-context";

export function getRequestContext(): RequestContext {
  const ctx = requestContext.getStore();
  if (!ctx) throw new Error("No request context — authMiddleware not applied.");
  return ctx;
}

export const getRequestClient = () => getRequestContext().supabase;   // RLS-enforced
export const getPublicUserId = () => getRequestContext().publicUserId; // public.users.id

// Trusted ops only (Track C3); not request-scoped, not RLS-enforced.
export function getServiceRoleClient(): SupabaseClient { /* SERVICE_ROLE_KEY */ }
```

### 5.3 The middleware

```ts
// auth/auth.middleware.ts
import type { Request, Response, NextFunction } from "express";
import { createClient } from "@supabase/supabase-js";
import { requestContext } from "./request-context";

const { SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;

function bearerToken(req: Request): string | null {
  const v = req.header("authorization")?.trim();
  if (!v?.toLowerCase().startsWith("bearer ")) return null;
  return v.slice(7).trim() || null;
}

function userScopedClient(accessToken: string) {
  return createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const requestId = res.locals.requestId;
  const fail = (status: number, code: string, message: string) =>
    res.status(status).json({ error: { code, message, requestId } });

  try {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return fail(500, "internal_error", "Auth is not configured.");
    }

    const accessToken = bearerToken(req);
    if (!accessToken) return fail(403, "forbidden", "Missing credentials.");

    // user-scoped client (RLS enforced) doubles as the verifier
    const supabase = userScopedClient(accessToken);
    const { data, error } = await supabase.auth.getUser(accessToken);
    if (error || !data.user) return fail(401, "unauthorized", "Invalid or expired session.");

    // resolve domain id via the same client → guarantees parity with RLS policies
    const { data: publicUserId, error: rpcErr } = await supabase.rpc("current_app_user_id");
    if (rpcErr || !publicUserId) return fail(401, "unauthorized", "Invalid or expired session.");

    // auth id (data.user.id) intentionally NOT stored — Golden rule
    requestContext.run(
      { supabase, publicUserId, email: data.user.email ?? null },
      () => next(),
    );
  } catch (err) {
    req.log?.warn?.({ err }, "auth error");
    return fail(500, "internal_error", "Internal server error.");
  }
}
```

### 5.4 How a handler consumes it

```ts
// routes/projects.ts
import { getRequestClient, getPublicUserId } from "../auth/accessors";

router.get("/projects", async (_req, res) => {
  const supabase = getRequestClient();   // RLS scopes rows to this user's workspaces
  const ownerId = getPublicUserId();     // public.users.id — for app logic, never the auth id

  // No manual WHERE on identity needed for read isolation — RLS enforces it.
  const { data, error } = await supabase.from("projects").select("*");
  if (error) return res.status(500).json({ error: { code: "internal_error", message: error.message } });
  res.json({ data });
});
```

Wiring:

```ts
const v1 = express.Router();
v1.use(authMiddleware);            // everything under /api/v1 is authenticated
v1.get("/me", meHandler);
app.use("/api/v1", v1);
```

Public routes (e.g. `GET /api/v1/health`) mount **before** / outside this router.

---

## 6. Open questions / decisions

1. **Cookie vs bearer (decided, revisit if SSR lands).** Recommend bearer
   (`Authorization` header). Revisit only if we adopt `@supabase/ssr` cookie
   sessions (roadmap Open Questions) or add an SSR landing page that needs the
   session server-side. Transport is isolated to §2.1, so a switch is contained.
2. **Refresh-token handling.** With access-token-only transport, the **SPA owns
   refresh** (Supabase JS auto-refresh) and sends a fresh access token per request;
   the API stays stateless and never holds a refresh token. On `401` the SPA
   refreshes and retries. Decide: do we need a server-driven refresh path at all?
   (Recommendation: no — keep the API stateless.)
3. **Where public-user resolution is cached.** Per-request, in the
   `AsyncLocalStorage` context (resolved once in §2.3). Open: add a short-TTL
   process cache keyed by auth id to skip the `current_app_user_id()` round-trip on
   hot paths? Defer until measured; correctness first.
4. **`getUser` round-trip cost.** `auth.getUser(token)` calls Supabase Auth per
   request. Acceptable to start. If it becomes hot, consider local JWT verification
   with the project JWT secret (validate signature + `exp`, read `sub` as the auth
   id) — but that **must not** change what reaches handlers (still only
   `public.users.id`).
5. **403-missing / 401-invalid convention.** We mirror harper-server. Confirm we're
   comfortable inverting the usual HTTP semantics, and that the app layer still uses
   403 (`forbidden`) for real post-auth authorization denials.
6. **Workspace selection.** `getPublicUserId()` identifies the user; a user can
   belong to multiple workspaces (`workspace_members`). How is the *active*
   workspace chosen per request — path param, header, or default? Out of scope for
   B2 (RLS already gates membership), but the resolution point should live alongside
   this middleware.
7. **service_role factory location.** Confirm `getServiceRoleClient()` ships in
   Track **C3** and that B2 only references the interface, not the implementation.
