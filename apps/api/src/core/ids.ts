// ID generation for v1 resources. Matches the existing `${prefix}_${rand}` scheme.

export function newId(prefix: string): string {
  return `${prefix}_` + Math.random().toString(36).slice(2, 10);
}

export function newRequestId(): string {
  return newId("req");
}
