// Recovery helpers for the generation-progress UI (PR #8).
//
// The progress screen needs to answer two questions after a refresh:
//   1. Which run, if any, is still active for this project?
//   2. Which terminal run produced the last visible project state, so the UI
//      can keep showing it while the user decides what to do next?
//
// The list endpoint (PR #4) is the authoritative source. sessionStorage is a
// fast hint so the first paint after a refresh does not flash an empty state.

import { GenerationRun, GenerationRunStatus } from "../types";
import {
  ACTIVE_RUN_STATUSES,
  isRunActive,
  isRunTerminal,
} from "./status";

const LAST_RUN_HINT_PREFIX = "popcornReady:lastRunHint:";

export interface LastRunHint {
  runId: string;
  status: GenerationRunStatus;
  updatedAt: string;
}

// Returns the most recently updated active run for a project, or undefined if
// none are active. Stable sort: ties break on createdAt so two simultaneous
// runs still produce a deterministic recovery target.
export function findLatestActiveRun(runs: GenerationRun[]): GenerationRun | undefined {
  let best: GenerationRun | undefined;
  for (const run of runs) {
    if (!ACTIVE_RUN_STATUSES.has(run.status)) continue;
    if (!best) {
      best = run;
      continue;
    }
    if (compareRunRecency(run, best) > 0) {
      best = run;
    }
  }
  return best;
}

// Returns the most recently completed terminal run, used to keep the prior
// project state visible after a refresh when no active run exists.
export function findLatestTerminalRun(runs: GenerationRun[]): GenerationRun | undefined {
  let best: GenerationRun | undefined;
  for (const run of runs) {
    if (!isRunTerminal(run.status)) continue;
    if (!best) {
      best = run;
      continue;
    }
    if (compareRunRecency(run, best) > 0) {
      best = run;
    }
  }
  return best;
}

// Picks the run the progress screen should restore to. Prefers an active run;
// otherwise falls back to the latest terminal run so the user sees the last
// completed video instead of a blank screen.
export function pickRecoveryTarget(runs: GenerationRun[]): GenerationRun | undefined {
  return findLatestActiveRun(runs) ?? findLatestTerminalRun(runs);
}

function compareRunRecency(a: GenerationRun, b: GenerationRun): number {
  const aUpdated = Date.parse(a.updatedAt);
  const bUpdated = Date.parse(b.updatedAt);
  if (aUpdated !== bUpdated) return aUpdated - bUpdated;
  return Date.parse(a.createdAt) - Date.parse(b.createdAt);
}

// sessionStorage hint helpers --------------------------------------------------
//
// These are deliberately tolerant: a missing window, a malformed payload, or a
// storage-quota error must never break the progress UI. The hint is best-effort
// and the list endpoint reconciles the truth.

export function lastRunHintKey(projectId: string): string {
  return `${LAST_RUN_HINT_PREFIX}${projectId}`;
}

export function readLastRunHint(
  projectId: string,
  storage: Storage | undefined = safeSessionStorage(),
): LastRunHint | undefined {
  if (!storage) return undefined;
  let raw: string | null;
  try {
    raw = storage.getItem(lastRunHintKey(projectId));
  } catch {
    return undefined;
  }
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as LastRunHint;
    if (
      parsed &&
      typeof parsed.runId === "string" &&
      typeof parsed.status === "string" &&
      typeof parsed.updatedAt === "string"
    ) {
      return parsed;
    }
  } catch {
    // fall through
  }
  return undefined;
}

export function writeLastRunHint(
  projectId: string,
  run: Pick<GenerationRun, "runId" | "status" | "updatedAt">,
  storage: Storage | undefined = safeSessionStorage(),
): void {
  if (!storage) return;
  const hint: LastRunHint = {
    runId: run.runId,
    status: run.status,
    updatedAt: run.updatedAt,
  };
  try {
    storage.setItem(lastRunHintKey(projectId), JSON.stringify(hint));
  } catch {
    // Quota/private-mode failures are non-fatal.
  }
}

export function clearLastRunHint(
  projectId: string,
  storage: Storage | undefined = safeSessionStorage(),
): void {
  if (!storage) return;
  try {
    storage.removeItem(lastRunHintKey(projectId));
  } catch {
    // ignore
  }
}

// Decides whether a cached hint is still worth showing. We keep terminal hints
// (so a refresh on the "your video is ready" screen restores it) and drop
// stale active hints once the server confirms a different active run.
export function reconcileHintWithRuns(
  hint: LastRunHint | undefined,
  runs: GenerationRun[],
): GenerationRun | undefined {
  if (!hint) return undefined;
  const matched = runs.find((run) => run.runId === hint.runId);
  if (!matched) return undefined;
  if (isRunActive(matched.status) || isRunTerminal(matched.status)) {
    return matched;
  }
  return undefined;
}

function safeSessionStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}
