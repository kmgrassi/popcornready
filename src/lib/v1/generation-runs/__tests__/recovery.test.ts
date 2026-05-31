import assert from "node:assert/strict";
import test from "node:test";

import {
  clearLastRunHint,
  findLatestActiveRun,
  findLatestTerminalRun,
  lastRunHintKey,
  pickRecoveryTarget,
  readLastRunHint,
  reconcileHintWithRuns,
  writeLastRunHint,
} from "../recovery";
import { GenerationRun, GenerationRunStatus } from "../../types";

function makeRun(overrides: Partial<GenerationRun> & { runId: string }): GenerationRun {
  return {
    projectId: "proj_1",
    status: "queued" as GenerationRunStatus,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length(): number {
    return this.data.size;
  }
  clear(): void {
    this.data.clear();
  }
  getItem(key: string): string | null {
    return this.data.has(key) ? this.data.get(key)! : null;
  }
  key(index: number): string | null {
    return Array.from(this.data.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

test("findLatestActiveRun returns the most recently updated queued/running run", () => {
  const runs: GenerationRun[] = [
    makeRun({ runId: "r1", status: "running", updatedAt: "2026-01-01T00:00:01.000Z" }),
    makeRun({ runId: "r2", status: "running", updatedAt: "2026-01-01T00:00:05.000Z" }),
    makeRun({ runId: "r3", status: "succeeded", updatedAt: "2026-01-01T00:00:09.000Z" }),
    makeRun({ runId: "r4", status: "queued", updatedAt: "2026-01-01T00:00:02.000Z" }),
  ];
  const latest = findLatestActiveRun(runs);
  assert.equal(latest?.runId, "r2");
});

test("findLatestActiveRun returns undefined when no run is queued or running", () => {
  const runs: GenerationRun[] = [
    makeRun({ runId: "r1", status: "succeeded" }),
    makeRun({ runId: "r2", status: "failed" }),
    makeRun({ runId: "r3", status: "canceled" }),
  ];
  assert.equal(findLatestActiveRun(runs), undefined);
});

test("findLatestActiveRun breaks ties on createdAt", () => {
  const runs: GenerationRun[] = [
    makeRun({
      runId: "r1",
      status: "running",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T01:00:00.000Z",
    }),
    makeRun({
      runId: "r2",
      status: "running",
      createdAt: "2026-01-01T00:30:00.000Z",
      updatedAt: "2026-01-01T01:00:00.000Z",
    }),
  ];
  assert.equal(findLatestActiveRun(runs)?.runId, "r2");
});

test("findLatestTerminalRun returns the most recently updated terminal run", () => {
  const runs: GenerationRun[] = [
    makeRun({ runId: "r1", status: "succeeded", updatedAt: "2026-01-01T00:00:01.000Z" }),
    makeRun({ runId: "r2", status: "failed", updatedAt: "2026-01-01T00:00:09.000Z" }),
    makeRun({ runId: "r3", status: "running", updatedAt: "2026-01-01T00:00:11.000Z" }),
  ];
  assert.equal(findLatestTerminalRun(runs)?.runId, "r2");
});

test("pickRecoveryTarget prefers active over terminal runs", () => {
  const runs: GenerationRun[] = [
    makeRun({ runId: "r1", status: "succeeded", updatedAt: "2026-01-01T00:01:00.000Z" }),
    makeRun({ runId: "r2", status: "queued", updatedAt: "2026-01-01T00:00:01.000Z" }),
  ];
  assert.equal(pickRecoveryTarget(runs)?.runId, "r2");
});

test("pickRecoveryTarget falls back to the latest terminal run when nothing is active", () => {
  const runs: GenerationRun[] = [
    makeRun({ runId: "r1", status: "failed", updatedAt: "2026-01-01T00:00:01.000Z" }),
    makeRun({ runId: "r2", status: "succeeded", updatedAt: "2026-01-01T00:00:05.000Z" }),
  ];
  assert.equal(pickRecoveryTarget(runs)?.runId, "r2");
});

test("pickRecoveryTarget returns undefined for an empty list", () => {
  assert.equal(pickRecoveryTarget([]), undefined);
});

test("writeLastRunHint then readLastRunHint round-trips", () => {
  const storage = new MemoryStorage();
  const run = makeRun({
    runId: "r1",
    status: "running",
    updatedAt: "2026-01-01T00:00:01.000Z",
  });
  writeLastRunHint("proj_1", run, storage);
  const hint = readLastRunHint("proj_1", storage);
  assert.deepEqual(hint, {
    runId: "r1",
    status: "running",
    updatedAt: "2026-01-01T00:00:01.000Z",
  });
  assert.equal(storage.getItem(lastRunHintKey("proj_1")) !== null, true);
});

test("readLastRunHint returns undefined when storage is empty or malformed", () => {
  const storage = new MemoryStorage();
  assert.equal(readLastRunHint("proj_1", storage), undefined);
  storage.setItem(lastRunHintKey("proj_1"), "{not json");
  assert.equal(readLastRunHint("proj_1", storage), undefined);
  storage.setItem(lastRunHintKey("proj_1"), JSON.stringify({ runId: 123 }));
  assert.equal(readLastRunHint("proj_1", storage), undefined);
});

test("clearLastRunHint removes the cached entry", () => {
  const storage = new MemoryStorage();
  writeLastRunHint(
    "proj_1",
    makeRun({ runId: "r1", status: "running", updatedAt: "2026-01-01T00:00:01.000Z" }),
    storage,
  );
  clearLastRunHint("proj_1", storage);
  assert.equal(readLastRunHint("proj_1", storage), undefined);
});

test("reconcileHintWithRuns drops hints that don't match any returned run", () => {
  const runs: GenerationRun[] = [makeRun({ runId: "r1", status: "running" })];
  const hint = { runId: "r2", status: "running" as const, updatedAt: "" };
  assert.equal(reconcileHintWithRuns(hint, runs), undefined);
});

test("reconcileHintWithRuns returns the matching server-side run", () => {
  const runs: GenerationRun[] = [
    makeRun({ runId: "r1", status: "succeeded", updatedAt: "2026-01-01T00:00:09.000Z" }),
  ];
  const hint = { runId: "r1", status: "running" as const, updatedAt: "stale" };
  const matched = reconcileHintWithRuns(hint, runs);
  assert.equal(matched?.runId, "r1");
  assert.equal(matched?.status, "succeeded");
});

test("storage helpers no-op when storage is undefined", () => {
  assert.doesNotThrow(() =>
    writeLastRunHint(
      "proj_1",
      makeRun({ runId: "r1", status: "running" }),
      undefined,
    ),
  );
  assert.doesNotThrow(() => clearLastRunHint("proj_1", undefined));
  assert.equal(readLastRunHint("proj_1", undefined), undefined);
});
