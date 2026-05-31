"use client";

// React hook for recovering a generation run on page load (PR #8).
//
// Reads the cached hint from sessionStorage for an instant first paint, then
// asks the list endpoint for the source-of-truth view: prefer the latest
// active run; if none are active, surface the most recent terminal run so the
// user keeps seeing the last completed project state instead of an empty
// shell. The hint stays in sessionStorage so repeated refreshes survive even
// before the network responds.

import { useCallback, useEffect, useRef, useState } from "react";
import { GenerationRunClient } from "@/lib/v1/generation-runs/client";
import { GenerationRun } from "@/lib/v1/types";
import { isRunActive, isRunTerminal } from "@/lib/v1/generation-runs/status";
import {
  LastRunHint,
  pickRecoveryTarget,
  readLastRunHint,
  reconcileHintWithRuns,
  writeLastRunHint,
} from "@/lib/v1/generation-runs/recovery";

export type RecoveryPhase = "idle" | "loading" | "ready" | "error";

export interface RecoveryState {
  phase: RecoveryPhase;
  run?: GenerationRun;
  hint?: LastRunHint;
  error?: string;
}

export interface UseRunRecoveryOptions {
  projectId: string | undefined;
  client: GenerationRunClient;
  // Optional override; defaults to a no-op when window is undefined (SSR).
  storage?: Storage;
}

export function useRunRecovery({
  projectId,
  client,
  storage,
}: UseRunRecoveryOptions): RecoveryState & { refresh: () => void } {
  const [state, setState] = useState<RecoveryState>(() => {
    if (!projectId) return { phase: "idle" };
    const hint = readLastRunHint(projectId, storage);
    return { phase: "loading", hint };
  });

  // Track in-flight requests so a stale fetch from a previous projectId never
  // overwrites the latest state.
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    if (!projectId) return;
    const requestId = ++requestIdRef.current;
    setState((prev) => ({ ...prev, phase: "loading" }));
    try {
      const runs = await client.listRuns(projectId);
      if (requestId !== requestIdRef.current) return;
      const hint = readLastRunHint(projectId, storage);
      const matchedHint = reconcileHintWithRuns(hint, runs);
      const recovered = pickRecoveryTarget(runs) ?? matchedHint;
      if (recovered && (isRunActive(recovered.status) || isRunTerminal(recovered.status))) {
        writeLastRunHint(projectId, recovered, storage);
      }
      setState({ phase: "ready", run: recovered, hint });
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setState((prev) => ({
        ...prev,
        phase: "error",
        error: err instanceof Error ? err.message : "Failed to recover run.",
      }));
    }
  }, [projectId, client, storage]);

  useEffect(() => {
    if (!projectId) {
      requestIdRef.current += 1;
      setState({ phase: "idle" });
      return;
    }
    void load();
  }, [projectId, load]);

  return { ...state, refresh: load };
}
