import type {
  AssetKind,
  AssetStatus,
  BriefVersion,
  CompositionMode,
  GateableGenerationStageType,
  GenerationJob,
  GenerationRun,
  GenerationRunStatus,
  V1Project,
  VideoBriefInput,
} from "@popcorn/shared/v1/types";
import type { EditPlan, Project } from "@popcorn/shared/types";
import type { Asset } from "@popcorn/shared/assets/types";
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

export interface CreateProjectInput {
  name: string;
  brief?: VideoBriefInput;
}

export interface CreateProjectResponse extends ProjectResponse {
  briefVersion?: BriefVersion;
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

export interface StudioProjectResponse {
  project: Project | null;
}

export interface RegenerateBeatTileResponse {
  projectId: string;
  beatId: string;
  sceneId: string;
  storyboardAssetId: string | null;
  status: "regenerated" | "queued" | "pending_generator";
}

// Read-only projection consumed by the Storyboard view (storyboard-scenes PR5):
// the project's plan (Scenes → Beats) plus its pooled assets. The view resolves
// each beat's `beat_storyboard` sketch tile from `assets` by
// `role === "beat_storyboard"` && `depicts.beatId`. Plan/assets become populated
// once the PR1 (plan model) and PR2 (tile generation) backend wiring lands; until
// then the projection is empty and the view shows its empty state.
export interface StoryboardData {
  projectId: string | null;
  plan: EditPlan | null;
  assets: Asset[];
}

function studioProjectFromV1(project: V1Project): Project {
  return {
    id: project.id,
    goal: project.name,
    plan: project.plan ?? null,
    timeline: null,
    clips: [],
    critic: null,
    chat: [],
    updatedAt: project.updatedAt,
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
  getProject: (projectId: string) =>
    apiRequest<ProjectResponse>(
      `/api/v1/projects/${encodeURIComponent(projectId)}`
    ),
  // Persist an edited storyboard plan (Scenes -> Beats). Scene/beat ids must be
  // stable across edits; the API validates them as unique + non-empty.
  updateProjectPlan: (projectId: string, plan: EditPlan) =>
    apiRequest<ProjectResponse>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/plan`,
      { method: "PUT", body: plan }
    ),
  // Regenerate the storyboard sketch tile for a single beat (recompute-affected
  // only — triggers generation for just this beat).
  regenerateBeatTile: (projectId: string, beatId: string) =>
    apiRequest<RegenerateBeatTileResponse>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/storyboard/beats/${encodeURIComponent(beatId)}/regenerate`,
      { method: "POST", body: {} }
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
  getStudioProject: async (): Promise<StudioProjectResponse> => {
    const { projects } = await v1Api.listProjects({ limit: 1 });
    return {
      project: projects[0] ? studioProjectFromV1(projects[0]) : null,
    };
  },
  // Read-only selector for the Storyboard view. Resolves the current studio
  // project and returns its plan + pooled assets. Read-only by design (PR5).
  getStoryboard: async (): Promise<StoryboardData> => {
    const { project } = await v1Api.getStudioProject();
    return {
      projectId: project?.id ?? null,
      plan: project?.plan ?? null,
      assets: project?.assets ?? [],
    };
  },
  listCreatedVideos: async () => ({ videos: [] }),
};
