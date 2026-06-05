import { useCallback, useEffect, useRef, useState } from "react";
import type { GenerationRun } from "@popcorn/shared/v1/types";
import { isRunActive } from "../v1/generation-runs/status";

export const DASHBOARD_POLL_INTERVAL_MS = 5000;
export const DASHBOARD_HIDDEN_POLL_INTERVAL_MS = 30000;
export const DASHBOARD_ERROR_POLL_INTERVAL_MS = 10000;

export interface DashboardPollingOptions<T> {
  enabled?: boolean;
  fetcher: (signal: AbortSignal) => Promise<T>;
  hasActiveRuns: (value: T) => boolean;
  intervalMs?: number;
  hiddenIntervalMs?: number;
  errorIntervalMs?: number;
}

export interface DashboardPollingState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  refresh: () => void;
}

export function dashboardHasActiveRuns(
  runs: Array<Pick<GenerationRun, "status">>,
): boolean {
  return runs.some((run) => isRunActive(run.status));
}

export function useDashboardPolling<T>({
  enabled = true,
  fetcher,
  hasActiveRuns,
  intervalMs = DASHBOARD_POLL_INTERVAL_MS,
  hiddenIntervalMs = DASHBOARD_HIDDEN_POLL_INTERVAL_MS,
  errorIntervalMs = DASHBOARD_ERROR_POLL_INTERVAL_MS,
}: DashboardPollingOptions<T>): DashboardPollingState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(enabled);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const pollRef = useRef<(() => void) | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const refresh = useCallback(() => {
    pollRef.current?.();
  }, []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function poll() {
      clearTimer();
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      try {
        const next = await fetcher(controller.signal);
        if (cancelled) return;

        setData(next);
        setError(null);
        setLoading(false);

        if (hasActiveRuns(next)) {
          const nextInterval =
            document.visibilityState === "hidden" ? hiddenIntervalMs : intervalMs;
          timerRef.current = setTimeout(poll, nextInterval);
        }
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
        timerRef.current = setTimeout(poll, errorIntervalMs);
      }
    }

    pollRef.current = () => {
      void poll();
    };

    void poll();

    function onVisibilityChange() {
      if (document.visibilityState !== "visible") return;
      pollRef.current?.();
    }

    function onFocus() {
      pollRef.current?.();
    }

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onFocus);

    return () => {
      cancelled = true;
      clearTimer();
      controllerRef.current?.abort();
      pollRef.current = null;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
    };
  }, [
    clearTimer,
    enabled,
    errorIntervalMs,
    fetcher,
    hasActiveRuns,
    hiddenIntervalMs,
    intervalMs,
  ]);

  return { data, error, loading, refresh };
}
