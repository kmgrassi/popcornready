// Per-request Supabase context, propagated without parameter threading.
//
// authMiddleware (src/middleware/auth.ts) resolves the caller once and runs the
// rest of the request inside this AsyncLocalStorage store. Downstream code reads
// the user-scoped (RLS-enforced) client and the caller's DOMAIN id
// (public.users.id) via the accessors in clients.ts.
//
// Golden rule: the auth user id (auth.uid()) is NEVER placed in this context. The
// store only ever carries public.users.id, exactly as docs/supabase-identity-and-rls.md
// requires.

import { AsyncLocalStorage } from "node:async_hooks";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface RequestContext {
  /** User-scoped Supabase client (anon key + caller bearer token). RLS-enforced. */
  supabase: SupabaseClient;
  /** Caller's public.users.id (domain id). NEVER the auth id. */
  publicUserId: string;
  /** Caller's email, if present on the verified session. */
  email: string | null;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();
