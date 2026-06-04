// Service-role Supabase client for the v1 job/timeline store.
//
// The v1 store is server-trusted: it resolves and enforces workspace/project
// tenancy in application code (every query filters by workspaceId/projectId and
// keys on the domain id `public.users.id` per docs/supabase-identity-and-rls.md,
// never the auth id). It therefore runs with the service_role key, which
// bypasses RLS. RLS still protects the tables from any direct PostgREST/client
// access. Never import this from browser code — the service_role key is
// server-only.
//
// TODO: replace with shared clients.ts from the auth-middleware PR. That PR owns
// apps/api/src/lib/supabase/clients.ts; once it lands, this local helper should
// be deleted and callers should import the shared service-role client. Until
// then this module keeps the job-store PR self-contained and decoupled.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

export class ServiceSupabaseConfigError extends Error {
  constructor(missing: string[]) {
    super(
      `v1 store Supabase client is not configured: ${missing.join(", ")} ${
        missing.length === 1 ? "is" : "are"
      } required.`
    );
    this.name = "ServiceSupabaseConfigError";
  }
}

export function getServiceSupabase(): SupabaseClient {
  if (client) return client;

  const url = (process.env.SUPABASE_URL ?? "").trim().replace(/\/$/, "");
  const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();

  const missing: string[] = [];
  if (!url) missing.push("SUPABASE_URL");
  if (!serviceRoleKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (missing.length > 0) throw new ServiceSupabaseConfigError(missing);

  client = createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
  return client;
}

// Test/reset hook so a test can inject a stub client (or clear the singleton).
export function setServiceSupabaseForTests(stub: SupabaseClient | null): void {
  client = stub;
}
