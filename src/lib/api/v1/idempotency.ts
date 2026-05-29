// Idempotency orchestration for mutating v1 routes.
//
// The lookup, the work, and the record insert must be atomic per (scope, key):
// otherwise two concurrent requests with the same Idempotency-Key both miss the
// lookup and both execute, creating duplicate projects/assets. We serialize them
// with an in-process keyed mutex.
//
// This lock is intentionally separate from the store's write chain: `produce`
// calls store mutations, and reusing the store's lock here would deadlock.
// The JSON store is process-local, so an in-process lock is the correct
// granularity. Distributed idempotency (multiple server instances) would need a
// shared lock or a unique DB constraint, deferred with the rest of hosted auth.

import { ApiError } from "./errors";
import { findIdempotencyRecord, saveIdempotencyRecord } from "./store";

export interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}

const keyLocks = new Map<string, Promise<unknown>>();

export function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = keyLocks.get(key) ?? Promise.resolve();
  // Run `fn` after the previous holder settles, regardless of its outcome.
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  keyLocks.set(key, tail);
  // Drop the entry once the chain drains so the map does not grow unbounded.
  tail.then(() => {
    if (keyLocks.get(key) === tail) keyLocks.delete(key);
  });
  return run;
}

export async function runIdempotent(
  scope: string,
  key: string,
  bodyHash: string,
  produce: () => Promise<ApiResult>
): Promise<ApiResult> {
  return withKeyLock(JSON.stringify([scope, key]), async () => {
    const existing = await findIdempotencyRecord(scope, key);
    if (existing) {
      if (existing.bodyHash !== bodyHash) {
        throw new ApiError(
          "idempotency_conflict",
          "This Idempotency-Key was already used with a different request body."
        );
      }
      return {
        status: existing.status,
        body: existing.responseBody as Record<string, unknown>,
      };
    }

    const result = await produce();
    if (result.status >= 200 && result.status < 300) {
      await saveIdempotencyRecord({
        scope,
        key,
        bodyHash,
        status: result.status,
        responseBody: result.body,
        createdAt: new Date().toISOString(),
      });
    }
    return result;
  });
}
