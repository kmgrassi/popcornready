import type {
  AssetKind,
  AssetStatus,
  BriefVersion,
  CompositionMode,
  JobStatus,
  GateableGenerationStageType,
  GenerationJob,
  GenerationRun,
  GenerationRunStatus,
  ProjectStoryboard,
  V1Asset,
  V1Project,
  VersionedTimeline,
  VideoBriefInput,
} from "@popcorn/shared/v1/types";
import type { Project } from "@popcorn/shared/types";
import type { GenerationRunDetail } from "./v1/generation-runs/status";
import {
  authenticatedFetch,
  getAuthenticatedHeaders,
} from "./supabase/fetch";

export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    requestId?: string;
    details?: unknown;
  };
}

export class ApiClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string | null;
  readonly details: unknown;

  constructor(status: number, envelope: ApiErrorEnvelope["error"]) {
    super(envelope.message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = envelope.code;
    this.requestId = envelope.requestId ?? null;
    this.details = envelope.details;
  }
}

export type ApiRequestOptions = Omit<RequestInit, "body"> & {
  body?: unknown;
  searchParams?: URLSearchParams | Record<string, string | number | boolean | null | undefined>;
};

function apiBaseUrl(): string {
  return (import.meta.env.VITE_API_URL?.trim() || "").replace(/\/$/, "");
}

function buildUrl(path: string, searchParams?: ApiRequestOptions["searchParams"]) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${apiBaseUrl()}${normalizedPath}`, window.location.origin);

  if (searchParams instanceof URLSearchParams) {
    searchParams.forEach((value, key) => url.searchParams.set(key, value));
  } else if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value !== null && value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  return url;
}

async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const envelope = isErrorEnvelope(data)
      ? data.error
      : {
          code: "internal_error",
          message: response.statusText || "API request failed.",
        };
    throw new ApiClientError(response.status, envelope);
  }

  return data as T;
}

function isErrorEnvelope(value: unknown): value is ApiErrorEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof (value as ApiErrorEnvelope).error?.code === "string" &&
    typeof (value as ApiErrorEnvelope).error?.message === "string"
  );
}

export async function apiRequest<T>(
  path: string,
  options: ApiRequestOptions = {}
): Promise<T> {
  const { body, headers: inputHeaders, searchParams, ...init } = options;
  const headers = new Headers(inputHeaders);

  let requestBody: BodyInit | undefined;
  if (body !== undefined) {
    headers.set("Content-Type", "application/json");
    requestBody = JSON.stringify(body);
  }

  const authHeaders = await getAuthenticatedHeaders(headers);
  const response = await authenticatedFetch(buildUrl(path, searchParams), {
    ...init,
    headers: authHeaders,
    body: requestBody,
  });

  return parseResponse<T>(response);
}

export interface MeResponse {
  actor:
    | string
    | {
        id: string;
        type?: string;
        email?: string | null;
      };
  workspaceId: string;
  workspaceName?: string;
  authMode: string;
  isLocal: boolean;
}

export interface ProjectsResponse {
  projects: V1Project[];
  pagination: {
    limit: number;
    nextCursor: string | null;
  };
}

export interface ProjectResponse {
  project: V1Project;
}

export interface ProjectStoryboardResponse {
  storyboard: ProjectStoryboard | null;
}

export interface SaveStoryboardBeatInput {
  id: string;
  intent: string;
  visualDescription?: string | null;
  dialogueSummary?: string | null;
  narration?: string | null;
  durationSec?: number | null;
  status?: ProjectStoryboard["scenes"][number]["beats"][number]["status"];
}

export interface SaveStoryboardSceneInput {
  id: string;
  title: string | null;
  summary?: string | null;
  setting?: string | null;
  mood?: string | null;
  durationSec?: number | null;
  status?: ProjectStoryboard["scenes"][number]["status"];
  beats: SaveStoryboardBeatInput[];
}

export interface SaveProjectStoryboardInput {
  id?: string | null;
  status?: ProjectStoryboard["status"];
  scenes: SaveStoryboardSceneInput[];
}

export interface ListPagination {
  limit: number;
  nextCursor: string | null;
}

export interface WorkspaceGenerationRun extends GenerationRun {
  projectName: string;
}

export type WorkspaceAssetSource = "uploaded" | "generated";

export interface WorkspaceAsset {
  id: string;
  assetId?: string;
  projectId: string;
  projectName: string;
  kind: AssetKind;
  status: AssetStatus;
  source: WorkspaceAssetSource | "upload" | "remote_url" | "local_path" | "imported" | "derived";
  filename?: string;
  title?: string;
  description?: string;
  url?: string;
  thumbnailUrl?: string;
  durationSec?: number;
  visibility?: "public" | "private";
  createdAt: string;
  updatedAt?: string;
}

export interface WorkspaceOutput {
  artifactId: string;
  projectId: string;
  projectName: string;
  timelineId?: string;
  url?: string;
  playbackUrl?: string;
  thumbnailUrl?: string;
  durationSec?: number;
  format?: string;
  createdAt: string;
}

export interface WorkspaceGenerationRunsResponse {
  runs: WorkspaceGenerationRun[];
  pagination: ListPagination;
}

export interface WorkspaceAssetsResponse {
  assets: WorkspaceAsset[];
  pagination: ListPagination;
}

export interface WorkspaceOutputsResponse {
  outputs: WorkspaceOutput[];
  pagination: ListPagination;
}

export interface GenerationRunArtifactResponse {
  artifact: {
    artifactId: string;
    runId: string;
    stageId: string;
    itemId?: string;
    kind: string;
    content: unknown;
    createdAt: string;
  };
  timelineId?: string;
}

export interface CreateProjectInput {
  name: string;
  brief?: VideoBriefInput;
}

export interface CreateProjectResponse extends ProjectResponse {
  briefVersion?: BriefVersion;
}

export interface AssetUploadUserContext {
  description?: string;
  intendedUse?: Array<
    | "primary_footage"
    | "b_roll"
    | "style_reference"
    | "music"
    | "voiceover"
    | "dialogue"
    | "sound_effect"
  >;
}

export interface CreateAssetUploadInput {
  filename: string;
  contentType: string;
  sizeBytes: number;
  kind: AssetKind;
  durationSec?: number;
  userContext?: AssetUploadUserContext;
}

export interface CreateAssetUploadResponse {
  upload: {
    assetId: string;
    key: string;
    bucket: "assets-public" | "assets-private";
    method: "put" | "multipart";
    contentType: string;
    expiresAt: string;
    put?: {
      url: string;
      headers: Record<string, string>;
    };
    multipart?: {
      uploadId: string;
      partSizeBytes: number;
      parts: { partNumber: number; url: string }[];
    };
  };
}

export interface CompleteAssetUploadInput {
  uploadId?: string;
  parts?: { partNumber: number; etag: string }[];
}

export interface RejectGenerationRunInput {
  stageType?: GateableGenerationStageType;
  note?: string;
}

export interface StartGenerationRunInput {
  brief: VideoBriefInput;
  mode?: CompositionMode;
  allowGeneratedGapFill?: boolean;
  assetIds?: string[];
  reviewGates?: GateableGenerationStageType[];
  provider?: string;
  seedAsset?: {
    kind?: "image" | "video";
    provider?: string;
    prompt?: string;
    description?: string;
    durationSec?: number;
    size?: string;
    quality?: string;
    preflightReviewIterations?: number;
  };
  showCaptions?: boolean;
}

export interface StartUploadedFootageRunInput {
  briefVersionId: string;
  assetIds: string[];
  mode?: CompositionMode;
  allowGeneratedGapFill?: boolean;
  reviewGates?: GateableGenerationStageType[];
  showCaptions?: boolean;
}

export interface StartGenerationRunResponse {
  job: GenerationJob;
  runId: string | null;
}

export type ExportDurationPolicy =
  | "timeline_only"
  | "match_longest_media"
  | "fail_on_mismatch";

export interface ExportRenderArtifact {
  id: string;
  projectId: string;
  kind: "video/mp4";
  status: "pending_render" | "ready" | "failed";
  url: string | null;
  timelineId: string;
  durationSec: number;
  createdAt: string;
}

export interface ExportJobResult {
  artifactId?: string;
}

export interface ExportJob {
  id: string;
  type: "export";
  status: JobStatus;
  projectId: string;
  step?: string;
  result?: ExportJobResult;
  error?: {
    code: string;
    message: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface StartTimelineExportInput {
  format: "mp4";
  quality: "draft" | "standard" | "high";
  durationPolicy: ExportDurationPolicy;
  showCaptions: boolean;
}

export interface ExportJobResponse {
  job: ExportJob;
}

export interface ExportArtifactResponse {
  artifact: ExportRenderArtifact;
}

export interface ProjectTimelineResponse {
  timeline: VersionedTimeline | null;
}

export interface StudioProjectResponse {
  project: Project | null;
}

function studioProjectFromV1(project: V1Project): Project {
  return {
    id: project.id,
    goal: project.name,
    plan: null,
    timeline: null,
    clips: [],
    critic: null,
    chat: [],
    updatedAt: project.updatedAt,
  };
}

function workspaceAssetToClip(asset: WorkspaceAsset): Project["clips"][number] {
  return {
    id: asset.assetId ?? asset.id,
    filename: asset.filename ?? asset.title ?? asset.id,
    url: asset.url ?? asset.thumbnailUrl ?? "",
    kind: asset.kind,
    durationSec: asset.durationSec ?? 4,
    description: asset.description ?? asset.title ?? "",
    source: asset.source === "generated" ? "generated" : "upload",
  };
}

export const v1Api = {
  me: () => apiRequest<MeResponse>("/api/v1/me"),
  listProjects: (params?: { limit?: number; cursor?: string | null }) =>
    apiRequest<ProjectsResponse>("/api/v1/projects", {
      searchParams: params,
    }),
  createProject: (input: CreateProjectInput) =>
    apiRequest<CreateProjectResponse>("/api/v1/projects", {
      method: "POST",
      body: input,
    }),
  createAssetUploadUrl: (projectId: string, input: CreateAssetUploadInput) =>
    apiRequest<CreateAssetUploadResponse>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/assets/upload-url`,
      {
        method: "POST",
        body: input,
      }
    ),
  completeAssetUpload: (
    projectId: string,
    assetId: string,
    input: CompleteAssetUploadInput = {}
  ) =>
    apiRequest<{ asset: V1Asset }>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/complete`,
      {
        method: "POST",
        body: input,
      }
    ),
  getProject: (projectId: string) =>
    apiRequest<ProjectResponse>(
      `/api/v1/projects/${encodeURIComponent(projectId)}`
    ),
  getProjectStoryboard: (projectId: string, signal?: AbortSignal) =>
    apiRequest<ProjectStoryboardResponse>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/storyboard`,
      { signal }
    ),
  saveProjectStoryboard: (
    projectId: string,
    storyboard: SaveProjectStoryboardInput
  ) =>
    apiRequest<{ storyboard: ProjectStoryboard }>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/storyboard`,
      { method: "PUT", body: storyboard }
    ),
  getGenerationRun: (
    projectId: string,
    runId: string,
    signal?: AbortSignal
  ) =>
    apiRequest<GenerationRunDetail>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/generation-runs/${encodeURIComponent(runId)}`,
      { signal }
    ),
  getGenerationRunArtifact: (
    projectId: string,
    runId: string,
    artifactId: string,
    signal?: AbortSignal
  ) =>
    apiRequest<GenerationRunArtifactResponse>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/generation-runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`,
      { signal }
    ),
  listWorkspaceGenerationRuns: (
    workspaceId: string,
    params?: {
      status?: GenerationRunStatus | "all";
      projectId?: string;
      limit?: number;
      cursor?: string | null;
    },
    signal?: AbortSignal
  ) =>
    apiRequest<WorkspaceGenerationRunsResponse>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/generation-runs`,
      {
        signal,
        searchParams: {
          ...params,
          status: params?.status === "all" ? undefined : params?.status,
        },
      }
    ),
  listWorkspaceAssets: (
    workspaceId: string,
    params?: {
      kind?: AssetKind | "all";
      source?: WorkspaceAssetSource | "all";
      projectId?: string;
      limit?: number;
      cursor?: string | null;
    },
    signal?: AbortSignal
  ) =>
    apiRequest<WorkspaceAssetsResponse>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/assets`,
      {
        signal,
        searchParams: {
          ...params,
          kind: params?.kind === "all" ? undefined : params?.kind,
          source: params?.source === "all" ? undefined : params?.source,
        },
      }
    ),
  listWorkspaceOutputs: (
    workspaceId: string,
    params?: { projectId?: string; limit?: number; cursor?: string | null },
    signal?: AbortSignal
  ) =>
    apiRequest<WorkspaceOutputsResponse>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/outputs`,
      {
        signal,
        searchParams: params,
      }
    ),
  setAssetVisibility: (
    projectId: string,
    assetId: string,
    visibility: "public" | "private"
  ) =>
    apiRequest<{ asset: { id: string; visibility?: "public" | "private" } }>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/visibility`,
      {
        method: "PATCH",
        body: { visibility },
      }
    ),
  updateGenerationRun: (
    projectId: string,
    runId: string,
    action: "approve" | "reject" | "cancel",
    body?: RejectGenerationRunInput
  ) =>
    apiRequest<GenerationRunDetail>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/generation-runs/${encodeURIComponent(runId)}/${action}`,
      {
        method: "POST",
        body: body ?? {},
      }
    ),
  createTimelineRevision: (
    projectId: string,
    timelineId: string,
    message: string
  ) =>
    apiRequest<{ job: unknown }>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/timelines/${encodeURIComponent(timelineId)}/revisions`,
      {
        method: "POST",
        body: { message },
      }
    ),
  startPromptGenerationRun: (
    projectId: string,
    input: StartGenerationRunInput
  ) =>
    apiRequest<StartGenerationRunResponse>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/generation-entrypoints/prompt`,
      {
        method: "POST",
        body: input,
      }
    ),
  startUploadedFootageGenerationRun: (
    projectId: string,
    input: StartUploadedFootageRunInput
  ) =>
    apiRequest<StartGenerationRunResponse>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/generation-entrypoints/uploaded-footage`,
      {
        method: "POST",
        body: input,
      }
    ),
  startTimelineExport: (
    projectId: string,
    timelineId: string,
    input: StartTimelineExportInput
  ) =>
    apiRequest<ExportJobResponse>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/timelines/${encodeURIComponent(timelineId)}/exports`,
      {
        method: "POST",
        body: input,
      }
    ),
  getTimelineExport: (projectId: string, jobId: string, signal?: AbortSignal) =>
    apiRequest<ExportJobResponse>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/exports/${encodeURIComponent(jobId)}`,
      { signal }
    ),
  getLatestProjectTimeline: (projectId: string, signal?: AbortSignal) =>
    apiRequest<ProjectTimelineResponse>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/timelines/latest`,
      { signal }
    ),
  getExportArtifact: (
    projectId: string,
    artifactId: string,
    signal?: AbortSignal
  ) =>
    apiRequest<ExportArtifactResponse>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId)}`,
      { signal }
    ),
  getStudioProject: async (): Promise<StudioProjectResponse> => {
    const { projects } = await v1Api.listProjects({ limit: 1 });
    return {
      project: projects[0] ? studioProjectFromV1(projects[0]) : null,
    };
  },
  getStudioProjectById: async (
    projectId: string,
    timeline?: Project["timeline"] | null
  ): Promise<StudioProjectResponse> => {
    const [{ project }, { workspaceId }] = await Promise.all([
      v1Api.getProject(projectId),
      v1Api.me(),
    ]);
    const { assets } = await v1Api.listWorkspaceAssets(workspaceId, {
      projectId,
      limit: 100,
    });
    return {
      project: {
        ...studioProjectFromV1(project),
        timeline: timeline ?? null,
        clips: assets.map(workspaceAssetToClip),
      },
    };
  },
  listCreatedVideos: async () => ({ videos: [] }),
};
