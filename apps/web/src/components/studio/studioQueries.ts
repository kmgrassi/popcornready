import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project, Timeline } from "@popcorn/shared/types";
import type { GenerationRun } from "@popcorn/shared/v1/types";
import {
  v1Api,
  type ExportJobResponse,
  type StartTimelineExportInput,
} from "../../lib/api-client";
import type { GenerationRunResultArtifact } from "../../lib/v1/generation-runs/status";

const RUN_POLL_INTERVAL_MS = 2_000;
const REVIEW_GATE_POLL_INTERVAL_MS = 15_000;

const studioQueryKeys = {
  generationRun: (projectId: string, runId: string) =>
    ["studio", "projects", projectId, "generation-runs", runId] as const,
  reviewCut: (projectId: string, runId: string, timelineArtifactId: string | null) =>
    [
      "studio",
      "projects",
      projectId,
      "generation-runs",
      runId,
      "review-cut",
      timelineArtifactId,
    ] as const,
  latestTimeline: (projectId: string) =>
    ["studio", "projects", projectId, "timelines", "latest"] as const,
  timelineExport: (projectId: string, jobId: string) =>
    ["studio", "projects", projectId, "exports", jobId] as const,
  exportArtifact: (projectId: string, artifactId: string) =>
    ["studio", "projects", projectId, "artifacts", artifactId] as const,
};

function isRunTerminal(status: GenerationRun["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

function isExportTerminal(status: ExportJobResponse["job"]["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

function isTimeline(value: unknown): value is Timeline {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { segments?: unknown };
  return Array.isArray(candidate.segments);
}

function timelineFromArtifactContent(content: unknown): Timeline | null {
  if (isTimeline(content)) return content;
  const nested = (content as { timeline?: unknown } | null)?.timeline;
  return isTimeline(nested) ? nested : null;
}

export function useStudioGenerationRunQuery(
  projectId: string,
  runId: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: studioQueryKeys.generationRun(projectId, runId),
    queryFn: ({ signal }) => v1Api.getGenerationRun(projectId, runId, signal),
    enabled: enabled && Boolean(projectId && runId),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data || isRunTerminal(data.run.status)) return false;
      if (document.visibilityState === "hidden") return false;
      return data.run.reviewGate ? REVIEW_GATE_POLL_INTERVAL_MS : RUN_POLL_INTERVAL_MS;
    },
  });
}

export interface StudioReviewCut {
  project: Project | null;
  timeline: Timeline | null;
  timelineId?: string;
}

export function useStudioReviewCutQuery({
  projectId,
  runId,
  resultArtifacts,
  enabled,
}: {
  projectId: string;
  runId: string;
  resultArtifacts: GenerationRunResultArtifact[];
  enabled: boolean;
}) {
  const timelineArtifact = resultArtifacts.find((artifact) => artifact.kind === "timeline");

  return useQuery({
    queryKey: studioQueryKeys.reviewCut(projectId, runId, timelineArtifact?.artifactId ?? null),
    queryFn: async ({ signal }): Promise<StudioReviewCut> => {
      let timeline: Timeline | null = null;
      let timelineId: string | undefined;

      if (timelineArtifact) {
        const artifactResponse = await v1Api.getGenerationRunArtifact(
          projectId,
          runId,
          timelineArtifact.artifactId,
          signal,
        );
        timeline = timelineFromArtifactContent(artifactResponse.artifact.content);
        timelineId = artifactResponse.timelineId;
      }

      const { project } = await v1Api.getStudioProjectById(projectId, timeline);
      return {
        project,
        timeline: project?.timeline ?? timeline,
        timelineId,
      };
    },
    enabled: enabled && Boolean(projectId && runId),
  });
}

export function useStudioLatestTimelineQuery(projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: studioQueryKeys.latestTimeline(projectId),
    queryFn: ({ signal }) => v1Api.getLatestProjectTimeline(projectId, signal),
    enabled: enabled && Boolean(projectId),
  });
}

export function useStartStudioTimelineExportMutation(
  projectId: string,
  timelineId: string,
) {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (input: StartTimelineExportInput) =>
      v1Api.startTimelineExport(projectId, timelineId, input),
    onSuccess: ({ job }) => {
      client.setQueryData(studioQueryKeys.timelineExport(projectId, job.id), { job });
      void client.invalidateQueries({ queryKey: ["workspaces"] });
    },
  });
}

export function useStudioCreateTimelineRevisionMutation(
  projectId: string,
  timelineId: string,
) {
  return useMutation({
    mutationFn: (message: string) =>
      v1Api.createTimelineRevision(projectId, timelineId, message),
  });
}

export function useStudioTimelineExportQuery(
  projectId: string,
  jobId: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: studioQueryKeys.timelineExport(projectId, jobId),
    queryFn: ({ signal }) => v1Api.getTimelineExport(projectId, jobId, signal),
    enabled: enabled && Boolean(projectId && jobId),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data || isExportTerminal(data.job.status)) return false;
      if (document.visibilityState === "hidden") return false;
      return RUN_POLL_INTERVAL_MS;
    },
  });
}

export function useStudioExportArtifactQuery(
  projectId: string,
  artifactId: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: studioQueryKeys.exportArtifact(projectId, artifactId),
    queryFn: ({ signal }) => v1Api.getExportArtifact(projectId, artifactId, signal),
    enabled: enabled && Boolean(projectId && artifactId),
  });
}
