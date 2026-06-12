import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type BrowserSupabaseConfig = {
  envName: string;
  url: string;
  anonKey: string;
};

let client: SupabaseClient | null = null;

// Vite only exposes public variables through static `import.meta.env.VITE_*`
// member expressions. Dynamic lookups are not reliably replaced in the browser
// bundle, so keep these references explicit.
function clean(value: string | undefined): string {
  return value?.trim() || "";
}

export function resolveBrowserSupabaseConfig(): BrowserSupabaseConfig | null {
  const selectedEnv =
    clean(import.meta.env.VITE_SUPABASE_ENV).toLowerCase() || "default";

  if (selectedEnv === "dev") {
    const url =
      clean(import.meta.env.VITE_SUPABASE_DEV_URL) ||
      clean(import.meta.env.VITE_SUPABASE_URL);
    const anonKey =
      clean(import.meta.env.VITE_SUPABASE_DEV_ANON_KEY) ||
      clean(import.meta.env.VITE_SUPABASE_ANON_KEY);
    return url && anonKey ? { envName: "dev", url, anonKey } : null;
  }

  if (selectedEnv === "prod") {
    const url =
      clean(import.meta.env.VITE_SUPABASE_PROD_URL) ||
      clean(import.meta.env.VITE_SUPABASE_URL);
    const anonKey =
      clean(import.meta.env.VITE_SUPABASE_PROD_ANON_KEY) ||
      clean(import.meta.env.VITE_SUPABASE_ANON_KEY);
    return url && anonKey ? { envName: "prod", url, anonKey } : null;
  }

  const url = clean(import.meta.env.VITE_SUPABASE_URL);
  const anonKey = clean(import.meta.env.VITE_SUPABASE_ANON_KEY);
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

function cookieDomainsFor(hostname: string): Array<string | null> {
  const domains: Array<string | null> = [null];
  if (!hostname || hostname === "localhost" || /^[\d.]+$/.test(hostname)) {
    return domains;
  }

  domains.push(hostname, `.${hostname}`);
  const parts = hostname.split(".");
  for (let index = 1; index < parts.length - 1; index += 1) {
    domains.push(`.${parts.slice(index).join(".")}`);
  }
  return Array.from(new Set(domains));
}

function cookiePathsFor(pathname: string): string[] {
  const paths = new Set<string>(["/"]);
  const parts = pathname.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    paths.add(current);
  }
  return Array.from(paths);
}

function clearAccessibleCookies() {
  try {
    const cookieNames = document.cookie
      .split(";")
      .map((cookie) => cookie.split("=")[0]?.trim())
      .filter((name): name is string => Boolean(name));
    const domains = cookieDomainsFor(window.location.hostname);
    const paths = cookiePathsFor(window.location.pathname);

    for (const name of cookieNames) {
      for (const path of paths) {
        for (const domain of domains) {
          document.cookie = [
            `${encodeURIComponent(name)}=`,
            "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
            "Max-Age=0",
            `Path=${path}`,
            domain ? `Domain=${domain}` : "",
            "SameSite=Lax",
          ]
            .filter(Boolean)
            .join("; ");
        }
      }
    }
  } catch {
    // Cookie access can be blocked in hardened browser contexts.
  }
}

export function clearBrowserSessionState() {
  try {
    window.localStorage.clear();
  } catch {
    // Ignore storage access failures.
  }

  try {
    window.sessionStorage.clear();
  } catch {
    // Ignore storage access failures.
  }

  clearAccessibleCookies();
}

export function getSupabaseClient(): SupabaseClient {
  if (client) return client;

  const config = resolveBrowserSupabaseConfig();
  if (!config) {
    throw new Error(
      "Supabase browser auth is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY."
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
