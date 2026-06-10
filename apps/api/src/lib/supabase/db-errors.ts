import { ApiError } from "../../core/errors";

export const PGRST_NO_ROWS = "PGRST116";

export interface SupabaseErrorLike {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

export function isMissingRow(error: SupabaseErrorLike | null): boolean {
  return error?.code === PGRST_NO_ROWS;
}

export function databaseError(
  operation: string,
  error: SupabaseErrorLike | null
): ApiError {
  const dbCode = error?.code ?? "unknown";
  const dbMessage = error?.message ?? "Unknown database error.";
  return new ApiError(
    "database_error",
    `Database operation failed: ${operation}.`,
    {
      operation,
      dbCode,
      dbMessage,
      ...(error?.details ? { dbDetails: error.details } : {}),
      ...(error?.hint ? { dbHint: error.hint } : {}),
    }
  );
}

export function throwDatabaseError(
  operation: string,
  error: SupabaseErrorLike | null
): void {
  if (error) throw databaseError(operation, error);
}
