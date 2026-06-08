import type {
  DashboardGenerationRun,
  DashboardSummary,
} from "@popcorn/shared/v1/dashboard";
import { isRunActive } from "../generation-runs/status";

export const DASHBOARD_ACTIVE_POLL_INTERVAL_MS = 5_000;
export const DASHBOARD_HIDDEN_POLL_INTERVAL_MS = 30_000;
export const DASHBOARD_ERROR_POLL_INTERVAL_MS = 10_000;

export function dashboardSummaryHasActiveRuns(
  summary: DashboardSummary | null | undefined,
): boolean {
  return summary?.activeRuns.some((run) => isRunActive(run.status)) ?? false;
}

export function dashboardRunsHaveActiveRuns(
  runs: readonly DashboardGenerationRun[],
): boolean {
  return runs.some((run) => isRunActive(run.status));
}

export interface DashboardPollerOptions<TPayload> {
  fetchPayload: (signal: AbortSignal) => Promise<TPayload>;
  onPayload: (payload: TPayload) => void;
  onError?: (error: unknown) => void;
  shouldContinue: (payload: TPayload) => boolean;
  visibleIntervalMs?: number;
  hiddenIntervalMs?: number;
  errorIntervalMs?: number;
}

export interface DashboardPoller {
  refresh: () => void;
  stop: () => void;
}

export function startDashboardPoller<TPayload>({
  fetchPayload,
  onPayload,
  onError,
  shouldContinue,
  visibleIntervalMs = DASHBOARD_ACTIVE_POLL_INTERVAL_MS,
  hiddenIntervalMs = DASHBOARD_HIDDEN_POLL_INTERVAL_MS,
  errorIntervalMs = DASHBOARD_ERROR_POLL_INTERVAL_MS,
}: DashboardPollerOptions<TPayload>): DashboardPoller {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;

  function clearTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function schedule(delayMs: number) {
    clearTimer();
    if (!stopped) timer = setTimeout(poll, delayMs);
  }

  async function poll() {
    clearTimer();
    controller?.abort();
    const activeController = new AbortController();
    controller = activeController;

    try {
      const payload = await fetchPayload(activeController.signal);
      if (stopped || activeController.signal.aborted) return;

      onPayload(payload);
      if (!shouldContinue(payload)) return;

      schedule(
        document.visibilityState === "hidden"
          ? hiddenIntervalMs
          : visibleIntervalMs,
      );
    } catch (error) {
      if (stopped || activeController.signal.aborted) return;
      onError?.(error);
      schedule(errorIntervalMs);
    }
  }

  function refresh() {
    void poll();
  }

  function onVisibilityChange() {
    if (document.visibilityState === "visible") refresh();
  }

  function stop() {
    stopped = true;
    clearTimer();
    controller?.abort();
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("focus", refresh);
  }

  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("focus", refresh);
  refresh();

  return { refresh, stop };
}
