"use client";

import { getSupabaseAccessToken, resolveBrowserSupabaseConfig } from "./browser";

export async function authenticatedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {}
) {
  if (!resolveBrowserSupabaseConfig()) return fetch(input, init);

  const token = await getSupabaseAccessToken();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);

  return fetch(input, {
    ...init,
    headers,
  });
}
