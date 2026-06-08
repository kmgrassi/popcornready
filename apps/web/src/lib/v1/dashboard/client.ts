import type {
  DashboardAssetFilters,
  DashboardAssetsResponse,
  DashboardGenerationRunFilters,
  DashboardGenerationRunsResponse,
  DashboardOutputFilters,
  DashboardOutputsResponse,
  DashboardSummaryResponse,
} from "@popcorn/shared/v1/dashboard";
import { apiRequest } from "../../api-client";

function workspacePath(workspaceId: string, suffix: string): string {
  return `/api/v1/workspaces/${encodeURIComponent(workspaceId)}${suffix}`;
}

function searchParams<TFilters extends object>(
  filters: TFilters,
): Record<string, string | number | boolean | null | undefined> {
  const params: Record<string, string | number | boolean | null | undefined> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null ||
      value === undefined
    ) {
      params[key] = value;
    }
  }
  return params;
}

export const dashboardApi = {
  getSummary: (workspaceId: string, signal?: AbortSignal) =>
    apiRequest<DashboardSummaryResponse>(workspacePath(workspaceId, "/dashboard"), {
      signal,
    }),

  listGenerationRuns: (
    workspaceId: string,
    filters: DashboardGenerationRunFilters = {},
    signal?: AbortSignal,
  ) =>
    apiRequest<DashboardGenerationRunsResponse>(
      workspacePath(workspaceId, "/generation-runs"),
      {
        searchParams: searchParams(filters),
        signal,
      },
    ),

  listAssets: (
    workspaceId: string,
    filters: DashboardAssetFilters = {},
    signal?: AbortSignal,
  ) =>
    apiRequest<DashboardAssetsResponse>(workspacePath(workspaceId, "/assets"), {
      searchParams: searchParams(filters),
      signal,
    }),

  listOutputs: (
    workspaceId: string,
    filters: DashboardOutputFilters = {},
    signal?: AbortSignal,
  ) =>
    apiRequest<DashboardOutputsResponse>(workspacePath(workspaceId, "/outputs"), {
      searchParams: searchParams(filters),
      signal,
    }),
};
