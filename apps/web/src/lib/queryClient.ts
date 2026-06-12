import {
  QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryFunctionContext,
  type UseQueryOptions,
} from "@tanstack/react-query";
import type { DashboardSummaryResponse } from "@popcorn/shared/v1/dashboard";
import type { GenerationRun } from "@popcorn/shared/v1/types";
import {
  ApiClientError,
  v1Api,
  type MeResponse,
  type RejectGenerationRunInput,
} from "./api-client";
import { dashboardApi } from "./v1/dashboard/client";
import type { GenerationRunDetail } from "./v1/generation-runs/status";

const DEFAULT_STALE_TIME_MS = 15_000;
const POLL_INTERVAL_MS = 2_000;
const REVIEW_POLL_INTERVAL_MS = 15_000;
const DASHBOARD_POLL_INTERVAL_MS = 5_000;
const DASHBOARD_HIDDEN_POLL_INTERVAL_MS = 30_000;

function retryApiFailure(failureCount: number, error: Error): boolean {
  if (error instanceof ApiClientError && error.status >= 400 && error.status < 500) {
    return false;
  }
  return failureCount < 2;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: DEFAULT_STALE_TIME_MS,
      retry: retryApiFailure,
      refetchOnWindowFocus: true,
    },
    mutations: {
      retry: false,
    },
  },
});

export const queryKeys = {
  me: (authScope: string) => ["me", authScope] as const,
  dashboardSummary: (workspaceId: string) =>
    ["dashboard", "summary", workspaceId] as const,
  generationRun: (projectId: string, runId: string) =>
    ["projects", projectId, "generation-runs", runId] as const,
};

type MeQueryKey = ReturnType<typeof queryKeys.me>;
type QuerySignal = QueryFunctionContext["signal"];

function isTerminal(status: GenerationRun["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

function shouldPollRun(run: GenerationRunDetail | undefined): boolean {
  return Boolean(run && !isTerminal(run.run.status));
}

export function useMeQuery(
  authScope: string,
  options: Omit<
    UseQueryOptions<MeResponse, Error, MeResponse, MeQueryKey>,
    "queryKey" | "queryFn"
  > = {},
) {
  return useQuery({
    queryKey: queryKeys.me(authScope),
    queryFn: () => v1Api.me(),
    ...options,
  });
}

export function useDashboardSummaryQuery(authScope: string) {
  const meQuery = useMeQuery(authScope);

  const summaryQuery = useQuery({
    queryKey: meQuery.data
      ? queryKeys.dashboardSummary(meQuery.data.workspaceId)
      : ["dashboard", "summary", "pending"],
    queryFn: ({ signal }: { signal: QuerySignal }) =>
      dashboardApi.getSummary(meQuery.data!.workspaceId, signal),
    enabled: Boolean(meQuery.data),
    refetchInterval: (query) => {
      const data = query.state.data as DashboardSummaryResponse | undefined;
      if (!data?.summary.activeRuns.length) return false;
      return document.visibilityState === "hidden"
        ? DASHBOARD_HIDDEN_POLL_INTERVAL_MS
        : DASHBOARD_POLL_INTERVAL_MS;
    },
  });

  return {
    data: summaryQuery.data ?? null,
    error: meQuery.error ?? summaryQuery.error ?? null,
    loading: meQuery.isLoading || summaryQuery.isLoading,
    refresh: () => {
      void meQuery.refetch();
      void summaryQuery.refetch();
    },
  };
}

export function useGenerationRunQuery(projectId: string, runId: string) {
  return useQuery({
    queryKey: queryKeys.generationRun(projectId, runId),
    queryFn: ({ signal }: { signal: QuerySignal }) =>
      v1Api.getGenerationRun(projectId, runId, signal),
    refetchInterval: (query) => {
      const data = query.state.data as GenerationRunDetail | undefined;
      if (!shouldPollRun(data)) return false;
      if (document.visibilityState === "hidden") return false;
      return data?.run.reviewGate ? REVIEW_POLL_INTERVAL_MS : POLL_INTERVAL_MS;
    },
  });
}

export function useUpdateGenerationRunMutation(projectId: string, runId: string) {
  const client = useQueryClient();

  return useMutation({
    mutationFn: ({
      action,
      body,
    }: {
      action: "approve" | "reject" | "cancel";
      body?: RejectGenerationRunInput;
    }) => v1Api.updateGenerationRun(projectId, runId, action, body),
    onSuccess: (data) => {
      client.setQueryData(queryKeys.generationRun(projectId, runId), data);
    },
  });
}
