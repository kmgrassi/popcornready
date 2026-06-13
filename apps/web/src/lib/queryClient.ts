import {
  QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryFunctionContext,
  type UseQueryOptions,
} from "@tanstack/react-query";
import type { DashboardSummaryResponse } from "@popcorn/shared/v1/dashboard";
import type { AssetKind, GenerationRun } from "@popcorn/shared/v1/types";
import {
  ApiClientError,
  v1Api,
  type CreateProjectInput,
  type MeResponse,
  type RejectGenerationRunInput,
  type RegisterProjectUploadInput,
  type SaveProjectStoryboardInput,
  type StartGenerationRunInput,
  type StartTimelineExportInput,
  type StartUploadedFootageRunInput,
  type WorkspaceAssetSource,
} from "./api-client";
import { projectQueryKeys } from "./project-queries";
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
  projects: (params: { limit?: number; cursor?: string | null } = {}) =>
    ["projects", params] as const,
  project: (projectId: string) => ["projects", projectId] as const,
  projectStoryboard: (projectId: string) =>
    ["projects", projectId, "storyboard"] as const,
  dashboardSummary: (workspaceId: string) =>
    ["dashboard", "summary", workspaceId] as const,
  workspaceGenerationRuns: (
    workspaceId: string,
    params: {
      status?: GenerationRun["status"] | "all";
      projectId?: string;
      limit?: number;
      cursor?: string | null;
    } = {},
  ) => ["workspaces", workspaceId, "generation-runs", params] as const,
  workspaceAssets: (
    workspaceId: string,
    params: {
      kind?: AssetKind | "all";
      source?: WorkspaceAssetSource | "all";
      projectId?: string;
      limit?: number;
      cursor?: string | null;
    } = {},
  ) => ["workspaces", workspaceId, "assets", params] as const,
  workspaceOutputs: (
    workspaceId: string,
    params: { projectId?: string; limit?: number; cursor?: string | null } = {},
  ) => ["workspaces", workspaceId, "outputs", params] as const,
  assetMedia: (assetId: string) => ["assets", assetId, "media"] as const,
  generationRun: (projectId: string, runId: string) =>
    ["projects", projectId, "generation-runs", runId] as const,
  generationRunArtifact: (projectId: string, runId: string, artifactId: string) =>
    ["projects", projectId, "generation-runs", runId, "artifacts", artifactId] as const,
  latestProjectTimeline: (projectId: string) =>
    ["projects", projectId, "timelines", "latest"] as const,
  timelineExport: (projectId: string, jobId: string) =>
    ["projects", projectId, "exports", jobId] as const,
  exportArtifact: (projectId: string, artifactId: string) =>
    ["projects", projectId, "artifacts", artifactId] as const,
  studioProject: ["studio", "project"] as const,
  studioProjectById: (
    projectId: string,
    timeline: StudioProjectTimelineKey | null = null,
  ) => ["studio", "project", projectId, timeline] as const,
};

type MeQueryKey = ReturnType<typeof queryKeys.me>;
type QuerySignal = QueryFunctionContext["signal"];
type StudioProjectTimeline = NonNullable<
  Parameters<typeof v1Api.getStudioProjectById>[1]
>;
type StudioProjectTimelineKey = {
  aspectRatio: StudioProjectTimeline["aspectRatio"];
  fps: StudioProjectTimeline["fps"];
  showCaptions: StudioProjectTimeline["showCaptions"];
  segments: Array<{
    id: string;
    clipId: string;
    sourceInSec: number;
    sourceOutSec: number;
    beatId?: string;
    caption?: string;
  }>;
};

function isTerminal(status: GenerationRun["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

function shouldPollRun(run: GenerationRunDetail | undefined): boolean {
  return Boolean(run && !isTerminal(run.run.status));
}

function studioProjectTimelineKey(
  timeline: Parameters<typeof v1Api.getStudioProjectById>[1] | undefined,
): StudioProjectTimelineKey | null {
  if (!timeline) return null;
  return {
    aspectRatio: timeline.aspectRatio,
    fps: timeline.fps,
    showCaptions: timeline.showCaptions,
    segments: timeline.segments.map((segment) => ({
      id: segment.id,
      clipId: segment.clipId,
      sourceInSec: segment.sourceInSec,
      sourceOutSec: segment.sourceOutSec,
      beatId: segment.beatId,
      caption: segment.caption,
    })),
  };
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

export function useProjectsQuery(
  params: { limit?: number; cursor?: string | null } = {},
) {
  return useQuery({
    queryKey: queryKeys.projects(params),
    queryFn: () => v1Api.listProjects(params),
  });
}

export function useProjectQuery(projectId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.project(projectId),
    queryFn: () => v1Api.getProject(projectId),
    enabled: enabled && Boolean(projectId),
  });
}

export function useCreateProjectMutation() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateProjectInput) => v1Api.createProject(input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["projects"] });
      void client.invalidateQueries({ queryKey: ["dashboard"] });
      void client.invalidateQueries({ queryKey: ["studio", "project"] });
    },
  });
}

export function useSetProjectPosterMutation(projectId: string) {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (assetId: string) => v1Api.setProjectPoster(projectId, assetId),
    onSuccess: (data) => {
      client.setQueryData(queryKeys.project(projectId), data);
      void client.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}

export function useProjectStoryboardQuery(projectId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.projectStoryboard(projectId),
    queryFn: ({ signal }: { signal: QuerySignal }) =>
      v1Api.getProjectStoryboard(projectId, signal),
    enabled: enabled && Boolean(projectId),
  });
}

export function useSaveProjectStoryboardMutation(projectId: string) {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (storyboard: SaveProjectStoryboardInput) =>
      v1Api.saveProjectStoryboard(projectId, storyboard),
    onSuccess: (data) => {
      client.setQueryData(queryKeys.projectStoryboard(projectId), {
        storyboard: data.storyboard,
      });
      void client.invalidateQueries({
        queryKey: projectQueryKeys.storyboardPage(projectId),
      });
      void client.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}

export function useWorkspaceGenerationRunsQuery(
  workspaceId: string,
  params: {
    status?: GenerationRun["status"] | "all";
    projectId?: string;
    limit?: number;
    cursor?: string | null;
  } = {},
  enabled = true,
) {
  return useQuery({
    queryKey: queryKeys.workspaceGenerationRuns(workspaceId, params),
    queryFn: ({ signal }: { signal: QuerySignal }) =>
      v1Api.listWorkspaceGenerationRuns(workspaceId, params, signal),
    enabled: enabled && Boolean(workspaceId),
  });
}

export function useWorkspaceAssetsQuery(
  workspaceId: string,
  params: Parameters<typeof queryKeys.workspaceAssets>[1] = {},
  enabled = true,
) {
  return useQuery({
    queryKey: queryKeys.workspaceAssets(workspaceId, params),
    queryFn: ({ signal }: { signal: QuerySignal }) =>
      v1Api.listWorkspaceAssets(workspaceId, params, signal),
    enabled: enabled && Boolean(workspaceId),
  });
}

export function useWorkspaceOutputsQuery(
  workspaceId: string,
  params: { projectId?: string; limit?: number; cursor?: string | null } = {},
  enabled = true,
) {
  return useQuery({
    queryKey: queryKeys.workspaceOutputs(workspaceId, params),
    queryFn: ({ signal }: { signal: QuerySignal }) =>
      v1Api.listWorkspaceOutputs(workspaceId, params, signal),
    enabled: enabled && Boolean(workspaceId),
  });
}

export function useRefreshAssetMediaMutation() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (assetId: string) => v1Api.refreshAssetMedia(assetId),
    onSuccess: (data, assetId) => {
      client.setQueryData(queryKeys.assetMedia(assetId), data);
      void client.invalidateQueries({ queryKey: ["workspaces"] });
    },
  });
}

export function useSetAssetVisibilityMutation() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: ({
      projectId,
      assetId,
      visibility,
    }: {
      projectId: string;
      assetId: string;
      visibility: "public" | "private";
    }) => v1Api.setAssetVisibility(projectId, assetId, visibility),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["workspaces"] });
    },
  });
}

export function useRegisterProjectUploadMutation(projectId: string) {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (input: RegisterProjectUploadInput) =>
      v1Api.registerProjectUpload(projectId, input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["workspaces"] });
      void client.invalidateQueries({ queryKey: queryKeys.project(projectId) });
    },
  });
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

export function useGenerationRunArtifactQuery(
  projectId: string,
  runId: string,
  artifactId: string,
  enabled = true,
) {
  return useQuery({
    queryKey: queryKeys.generationRunArtifact(projectId, runId, artifactId),
    queryFn: ({ signal }: { signal: QuerySignal }) =>
      v1Api.getGenerationRunArtifact(projectId, runId, artifactId, signal),
    enabled: enabled && Boolean(projectId && runId && artifactId),
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

export function useStartPromptGenerationRunMutation(projectId: string) {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (input: StartGenerationRunInput) =>
      v1Api.startPromptGenerationRun(projectId, input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["dashboard"] });
      void client.invalidateQueries({ queryKey: ["workspaces"] });
    },
  });
}

export function useStartUploadedFootageGenerationRunMutation(projectId: string) {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (input: StartUploadedFootageRunInput) =>
      v1Api.startUploadedFootageGenerationRun(projectId, input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["dashboard"] });
      void client.invalidateQueries({ queryKey: ["workspaces"] });
    },
  });
}

export function useCreateTimelineRevisionMutation(projectId: string, timelineId: string) {
  return useMutation({
    mutationFn: (message: string) =>
      v1Api.createTimelineRevision(projectId, timelineId, message),
  });
}

export function useLatestProjectTimelineQuery(projectId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.latestProjectTimeline(projectId),
    queryFn: ({ signal }: { signal: QuerySignal }) =>
      v1Api.getLatestProjectTimeline(projectId, signal),
    enabled: enabled && Boolean(projectId),
  });
}

export function useStartTimelineExportMutation(projectId: string, timelineId: string) {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (input: StartTimelineExportInput) =>
      v1Api.startTimelineExport(projectId, timelineId, input),
    onSuccess: ({ job }) => {
      client.setQueryData(queryKeys.timelineExport(projectId, job.id), { job });
      void client.invalidateQueries({ queryKey: ["workspaces"] });
    },
  });
}

export function useTimelineExportQuery(
  projectId: string,
  jobId: string,
  enabled = true,
) {
  return useQuery({
    queryKey: queryKeys.timelineExport(projectId, jobId),
    queryFn: ({ signal }: { signal: QuerySignal }) =>
      v1Api.getTimelineExport(projectId, jobId, signal),
    enabled: enabled && Boolean(projectId && jobId),
  });
}

export function useExportArtifactQuery(
  projectId: string,
  artifactId: string,
  enabled = true,
) {
  return useQuery({
    queryKey: queryKeys.exportArtifact(projectId, artifactId),
    queryFn: ({ signal }: { signal: QuerySignal }) =>
      v1Api.getExportArtifact(projectId, artifactId, signal),
    enabled: enabled && Boolean(projectId && artifactId),
  });
}

export function useStudioProjectQuery() {
  return useQuery({
    queryKey: queryKeys.studioProject,
    queryFn: () => v1Api.getStudioProject(),
  });
}

export function useStudioProjectByIdQuery(
  projectId: string,
  timeline?: Parameters<typeof v1Api.getStudioProjectById>[1],
  enabled = true,
) {
  const timelineKey = studioProjectTimelineKey(timeline);

  return useQuery({
    queryKey: queryKeys.studioProjectById(projectId, timelineKey),
    queryFn: () => v1Api.getStudioProjectById(projectId, timeline),
    enabled: enabled && Boolean(projectId),
  });
}
