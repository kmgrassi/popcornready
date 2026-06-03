"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type BrowserSupabaseConfig = {
  envName: string;
  url: string;
  anonKey: string;
};

let client: SupabaseClient | null = null;

function readPublicEnv(name: string) {
  return process.env[name]?.trim() || "";
}

export function resolveBrowserSupabaseConfig(): BrowserSupabaseConfig | null {
  const selectedEnv =
    readPublicEnv("NEXT_PUBLIC_SUPABASE_ENV").toLowerCase() || "default";

  if (selectedEnv === "dev") {
    const url =
      readPublicEnv("NEXT_PUBLIC_SUPABASE_DEV_URL") ||
      readPublicEnv("NEXT_PUBLIC_SUPABASE_URL");
    const anonKey =
      readPublicEnv("NEXT_PUBLIC_SUPABASE_DEV_ANON_KEY") ||
      readPublicEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
    return url && anonKey ? { envName: "dev", url, anonKey } : null;
  }

  if (selectedEnv === "prod") {
    const url =
      readPublicEnv("NEXT_PUBLIC_SUPABASE_PROD_URL") ||
      readPublicEnv("NEXT_PUBLIC_SUPABASE_URL");
    const anonKey =
      readPublicEnv("NEXT_PUBLIC_SUPABASE_PROD_ANON_KEY") ||
      readPublicEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
    return url && anonKey ? { envName: "prod", url, anonKey } : null;
  }

  const url = readPublicEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = readPublicEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  return url && anonKey ? { envName: "default", url, anonKey } : null;
}

function projectRefFromUrl(urlString: string): string {
  try {
    const hostname = new URL(urlString).hostname.toLowerCase();
    const match = hostname.match(/^([a-z0-9-]+)\.supabase\.co$/i);
    if (match?.[1]) return match[1];
    return hostname.replace(/[^a-z0-9-]/g, "-") || "unknown";
  } catch {
    return (
      `raw-${urlString
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "-")
        .slice(0, 48)}` || "unknown"
    );
  }
}

function storageKey(config: BrowserSupabaseConfig) {
  return `sb-${config.envName}-${projectRefFromUrl(config.url)}-auth-token`;
}

function isSupabaseAuthStorageKey(key: string): boolean {
  return /^sb-[a-z0-9-]+-auth-token$/i.test(key);
}

function clearSupabaseAuthStorage(shouldRemove: (key: string) => boolean) {
  try {
    for (const key of Object.keys(window.localStorage)) {
      if (isSupabaseAuthStorageKey(key) && shouldRemove(key)) {
        window.localStorage.removeItem(key);
      }
    }
  } catch {
    // Some browser contexts block Web Storage. Supabase can still use its
    // in-memory fallback for the current page lifecycle.
  }
}

export function clearOtherSupabaseAuthStorage() {
  const config = resolveBrowserSupabaseConfig();
  if (!config) return;
  const activeKey = storageKey(config);
  clearSupabaseAuthStorage((key) => key !== activeKey);
}

export function clearAllSupabaseAuthStorage() {
  clearSupabaseAuthStorage(() => true);
}

export function getSupabaseClient(): SupabaseClient {
  if (client) return client;

  const config = resolveBrowserSupabaseConfig();
  if (!config) {
    throw new Error(
      "Supabase browser auth is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY."
    );
  }

  clearOtherSupabaseAuthStorage();
  client = createClient(config.url, config.anonKey, {
    auth: {
      storageKey: storageKey(config),
    },
  });
  return client;
}

export async function getSupabaseAccessToken(): Promise<string> {
  const { data, error } = await getSupabaseClient().auth.getSession();
  const token = data.session?.access_token?.trim();
  if (error || !token) {
    throw error || new Error("No Supabase access token available");
  }
  return token;
}
