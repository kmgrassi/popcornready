import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { ApiError } from "../errors";
import { runIdempotent } from "../idempotency";

// These exercise the v1 store, which now persists to Supabase Postgres (needs a
// live PostgREST gateway). Skipped unless Supabase env is configured; the store's
// idempotency round-trip is proven by the dockerized pg harness in this PR.
const SUPABASE_CONFIGURED = Boolean(
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
);
const dbTest: typeof test = SUPABASE_CONFIGURED ? test : (test.skip as typeof test);

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "popcornready-v1-idem-"));
  process.env.POPCORN_READY_LOCAL_DIR = tmpDir;
});

afterEach(async () => {
  delete process.env.POPCORN_READY_LOCAL_DIR;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

dbTest("concurrent same-key requests run the producer exactly once", async () => {
  let runs = 0;
  const produce = async () => {
    runs += 1;
    await delay(10); // widen the race window
    return { status: 201, body: { runs } };
  };

  const [a, b] = await Promise.all([
    runIdempotent("scope", "key", "hash", produce),
    runIdempotent("scope", "key", "hash", produce),
  ]);

  assert.equal(runs, 1, "producer should only execute once");
  assert.deepEqual(a, b);
  assert.deepEqual(a, { status: 201, body: { runs: 1 } });
});

dbTest("a replay with the same key+body returns the stored response", async () => {
  let runs = 0;
  const produce = async () => {
    runs += 1;
    return { status: 201, body: { id: "proj_1", runs } };
  };

  const first = await runIdempotent("scope", "key", "hash", produce);
  const second = await runIdempotent("scope", "key", "hash", produce);
  assert.equal(runs, 1);
  assert.deepEqual(first, second);
});

dbTest("a same key with a different body hash is a conflict", async () => {
  await runIdempotent("scope", "key", "hash-a", async () => ({
    status: 201,
    body: { ok: true },
  }));

  await assert.rejects(
    () =>
      runIdempotent("scope", "key", "hash-b", async () => ({
        status: 201,
        body: { ok: true },
      })),
    (err: unknown) =>
      err instanceof ApiError && err.code === "idempotency_conflict"
  );
});

dbTest("non-success results are not persisted and can be retried", async () => {
  let runs = 0;
  const produce = async () => {
    runs += 1;
    return { status: 400, body: { error: "bad" } };
  };

  await runIdempotent("scope", "key", "hash", produce);
  await runIdempotent("scope", "key", "hash", produce);
  assert.equal(runs, 2, "failed attempts should not be cached");
});

dbTest("different keys do not block each other", async () => {
  let runs = 0;
  const produce = async () => {
    runs += 1;
    return { status: 201, body: { runs } };
  };

  await Promise.all([
    runIdempotent("scope", "key-1", "hash", produce),
    runIdempotent("scope", "key-2", "hash", produce),
  ]);
  assert.equal(runs, 2);
});
