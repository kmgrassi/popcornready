import { useCallback } from "react";
import type { DashboardSummaryResponse } from "@popcorn/shared/v1/dashboard";
import { HeroCard } from "../components/home/HeroCard";
import { RecentOutputsStrip } from "../components/home/RecentOutputsStrip";
import { Button } from "../components/ui/Button";
import { ErrorState } from "../components/ui/StateCard";
import { v1Api } from "../lib/api-client";
import { dashboardSummaryHasActiveRuns } from "../lib/v1/dashboard/polling";
import { dashboardApi } from "../lib/v1/dashboard/client";
import { useDashboardPolling } from "../lib/dashboard/polling";
import { deriveNextAction } from "../lib/nextAction";
import styles from "./LaunchpadPage.module.css";

export function LaunchpadPage() {
  const fetchSummary = useCallback(async (signal: AbortSignal) => {
    const { workspaceId } = await v1Api.me();
    return dashboardApi.getSummary(workspaceId, signal);
  }, []);

  const {
    data,
    error,
    loading,
    refresh,
  } = useDashboardPolling<DashboardSummaryResponse>({
    fetcher: fetchSummary,
    hasActiveRuns: (payload) => dashboardSummaryHasActiveRuns(payload.summary),
  });

  const pulse = data?.summary ?? null;
  const action = deriveNextAction(pulse, []);

  return (
    <div className={styles.page}>
      {loading ? <LaunchpadSkeleton /> : null}

      {!loading && error ? (
        <ErrorState
          title="Unable to load Home"
          body="We could not load the workspace summary."
          error={error}
          onRetry={refresh}
        />
      ) : null}

      {!loading && !error ? (
        <>
          <HeroCard action={action} />
          <RecentOutputsStrip outputs={pulse?.recentOutputs ?? []} />
        </>
      ) : null}
    </div>
  );
}

function LaunchpadSkeleton() {
  return (
    <div className={styles.skeleton} aria-label="Loading Home">
      <span />
      <span />
      <span />
      <Button variant="cta" size="lg" disabled>
        Loading
      </Button>
    </div>
  );
}
