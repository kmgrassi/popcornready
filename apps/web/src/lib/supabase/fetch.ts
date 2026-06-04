import { getSupabaseAccessToken, resolveBrowserSupabaseConfig } from "./browser";

export async function getAuthenticatedHeaders(headers = new Headers()) {
  if (!resolveBrowserSupabaseConfig()) return headers;

  const token = await getSupabaseAccessToken();
  headers.set("Authorization", `Bearer ${token}`);
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
