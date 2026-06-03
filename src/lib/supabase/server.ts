import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export class SupabaseServerConfigError extends Error {
  constructor(missingNames: string[]) {
    super(
      `Supabase server auth is not configured: ${missingNames.join(", ")} ${
        missingNames.length === 1 ? "is" : "are"
      } required.`
    );
    this.name = "SupabaseServerConfigError";
  }
}

function readServerConfig(env: NodeJS.ProcessEnv = process.env) {
  const url = (env.SUPABASE_URL ?? "").trim().replace(/\/$/, "");
  const anonKey = (env.SUPABASE_ANON_KEY ?? "").trim();
  const missingNames: string[] = [];

  if (!url) missingNames.push("SUPABASE_URL");
  if (!anonKey) missingNames.push("SUPABASE_ANON_KEY");
  if (missingNames.length > 0) throw new SupabaseServerConfigError(missingNames);

  return { url, anonKey };
}

export function getUserScopedSupabase(
  accessToken: string,
  env: NodeJS.ProcessEnv = process.env
): SupabaseClient {
  const token = accessToken.trim();
  if (!token) throw new SupabaseServerConfigError(["accessToken"]);

  const { url, anonKey } = readServerConfig(env);
  return createClient(url, anonKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });
}

export async function getSupabaseAuthUser(accessToken: string) {
  const { data, error } = await getUserScopedSupabase(accessToken).auth.getUser(
    accessToken
  );
  if (error || !data.user) {
    throw error || new Error("No Supabase user returned for access token.");
  }
  return data.user;
}
