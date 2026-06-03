// Server-side Supabase client using the service_role key.
//
// The agent API resolves and enforces the workspace scope in application code
// (every store query filters by workspaceId/projectId), so server reads/writes
// run with the service_role key and bypass RLS. RLS still protects the tables
// from any direct client/PostgREST access. Never import this from client code —
// the service_role key must stay server-only.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

export class SupabaseAdminConfigError extends Error {
  constructor(missing: string[]) {
    super(
      `Supabase admin client is not configured: ${missing.join(", ")} ${
        missing.length === 1 ? "is" : "are"
      } required.`
    );
    this.name = "SupabaseAdminConfigError";
  }
}

export function getSupabaseAdmin(): SupabaseClient {
  if (client) return client;

  const url = (process.env.SUPABASE_URL ?? "").trim().replace(/\/$/, "");
  const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();

  const missing: string[] = [];
  if (!url) missing.push("SUPABASE_URL");
  if (!serviceRoleKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (missing.length > 0) throw new SupabaseAdminConfigError(missing);

  client = createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
  return client;
}
