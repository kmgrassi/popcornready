import type {
  BriefVersion,
  GateableGenerationStageType,
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
  actor: string;
  workspaceId: string;
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

export interface StudioProjectResponse {
  project: Project | null;
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
    plan: null,
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
  getGenerationRun: (
    projectId: string,
    runId: string,
    signal?: AbortSignal
  ) =>
    apiRequest<GenerationRunDetail>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/generation-runs/${encodeURIComponent(runId)}`,
      { signal }
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
