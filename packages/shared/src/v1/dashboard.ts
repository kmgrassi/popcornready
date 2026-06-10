import type {
  AssetKind,
  AssetStatus,
  GenerationRun,
  GenerationRunStatus,
  GenerationStageType,
  JobStatus,
  RunReviewGate,
  V1Asset,
} from "./types";

export const DASHBOARD_SCHEMA_VERSION = "dashboard.v1" as const;

export interface DashboardListPagination {
  limit: number;
  nextCursor: string | null;
}

export interface DashboardListResponse<TItem> {
  items: TItem[];
  pagination: DashboardListPagination;
}

export interface DashboardCounts {
  projects: number;
  activeRuns: number;
  outputs: number;
}

export interface DashboardActiveRunSummary {
  runId: string;
  projectId: string;
  projectName: string;
  status: GenerationRunStatus;
  reviewGate?: RunReviewGate | null;
  currentStageType?: GenerationStageType;
  progressPercent?: number;
  updatedAt: string;
}

export interface DashboardRecentOutput {
  artifactId: string;
  projectId: string;
  projectName: string;
  timelineId?: string;
  url?: string;
  thumbnailUrl?: string;
  durationSec?: number;
  format?: string;
  createdAt: string;
}

export interface DashboardSummary {
  schemaVersion: typeof DASHBOARD_SCHEMA_VERSION;
  counts: DashboardCounts;
  activeRuns: DashboardActiveRunSummary[];
  recentOutputs: DashboardRecentOutput[];
}

export interface DashboardSummaryResponse {
  summary: DashboardSummary;
}

export type DashboardGenerationRun = GenerationRun & {
  projectName: string;
};

export interface DashboardGenerationRunsResponse {
  runs: DashboardGenerationRun[];
  pagination: DashboardListPagination;
}

export type DashboardAssetSource = V1Asset["source"];

export interface DashboardAssetItem {
  assetId: string;
  projectId: string;
  projectName: string;
  kind: AssetKind;
  source: DashboardAssetSource;
  status: AssetStatus;
  filename: string;
  url: string;
  thumbnailUrl?: string;
  durationSec?: number;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardAssetsResponse {
  assets: DashboardAssetItem[];
  pagination: DashboardListPagination;
}

export interface DashboardOutputItem extends DashboardRecentOutput {
  jobId?: string;
  status?: Extract<JobStatus, "succeeded">;
  updatedAt?: string;
}

export interface DashboardOutputsResponse {
  outputs: DashboardOutputItem[];
  pagination: DashboardListPagination;
}

export interface DashboardPaginationParams {
  limit?: number;
  cursor?: string | null;
}

export interface DashboardGenerationRunFilters extends DashboardPaginationParams {
  status?: GenerationRunStatus;
  projectId?: string;
}

export interface DashboardAssetFilters extends DashboardPaginationParams {
  kind?: AssetKind;
  source?: DashboardAssetSource;
  projectId?: string;
}

export interface DashboardOutputFilters extends DashboardPaginationParams {
  projectId?: string;
}
