// Deterministic JSON helpers for asset graph hashing.
//
// Object keys are sorted recursively so insertion order never affects the
// semantic payload. Arrays keep order because order is meaningful for prompts,
// storyboard children, and provider inputs. Hashing itself lives in server
// packages so this shared package stays runtime-neutral.

export function canonicalJSON(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);

  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] === undefined) continue;
    out[key] = canonicalize(source[key]);
  }
  return out;
}
