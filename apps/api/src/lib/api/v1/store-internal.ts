// Shared low-level helpers for the v1 Postgres store layer. Extracted so per-table
// store files (orchestrator-store.ts, and the planned assets/projects/actions split)
// reuse one set of mappers instead of each re-deriving them or piling onto store.ts.

import { throwDatabaseError } from "../../supabase/db-errors";

// Normalize a Postgres timestamptz (or null) to an ISO-8601 string.
export function iso(value: string | null | undefined): string {
  if (!value) return new Date(0).toISOString();
  return new Date(value).toISOString();
}

// Map a supabase-js error to the typed database_error envelope (no-op on null).
export const throwOnError = (
  error: Parameters<typeof throwDatabaseError>[1],
  context: string
) => throwDatabaseError(`store.${context}`, error);

// Stamp a JSONB payload with its schema version on write.
export function markedJson(
  marker: string,
  value: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  return { schema_version: marker, ...value };
}

// Strip the schema-version marker on read.
export function unmarkedJson(
  value: Record<string, unknown> | null
): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const { schema_version: _schemaVersion, schema: _schema, ...rest } = value;
  void _schemaVersion;
  void _schema;
  return rest;
}
