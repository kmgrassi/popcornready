import { getSupabaseAccessToken, resolveBrowserSupabaseConfig } from "./browser";

export async function getAuthenticatedHeaders(headers = new Headers()) {
  if (!resolveBrowserSupabaseConfig()) return headers;

  try {
    const token = await getSupabaseAccessToken();
    headers.set("Authorization", `Bearer ${token}`);
  } catch {
    // No active session — send the request unauthenticated and let the API
    // decide: hybrid/local dev serves the autopilot identity, supabase mode
    // rejects it. (Avoids throwing before the request is even made.)
  }
  return headers;
}

export async function authenticatedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {}
) {
  const headers = new Headers(init.headers);

  return fetch(input, {
    ...init,
    headers: await getAuthenticatedHeaders(headers),
  });
}
