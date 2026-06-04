import type {
  BriefVersion,
  AssetKind,
  V1Project,
  VideoBriefInput,
} from "@popcorn/shared/v1/types";
import type { Project } from "@popcorn/shared/types";
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

function unavailable(feature: string): never {
  throw new ApiClientError(501, {
    code: "not_implemented",
    message: `${feature} is not available in the v1 API yet.`,
  });
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
  getStudioProject: async (): Promise<StudioProjectResponse> => {
    const { projects } = await v1Api.listProjects({ limit: 1 });
    return {
      project: projects[0] ? studioProjectFromV1(projects[0]) : null,
    };
  },
  createStudioProject: async (input: {
    goal: string;
    targetLengthSec: number;
    aspectRatio: VideoBriefInput["aspectRatio"];
    style?: string;
    storyContext?: Partial<VideoBriefInput>;
  }): Promise<StudioProjectResponse> => {
    const { project } = await v1Api.createProject({
      name: input.goal,
      brief: {
        goal: input.goal,
        targetLengthSec: input.targetLengthSec,
        aspectRatio: input.aspectRatio,
        style: input.style,
        platform: input.storyContext?.platform,
        audience: input.storyContext?.audience,
        format: input.storyContext?.format,
      },
    });
    return { project: studioProjectFromV1(project) };
  },
  listCreatedVideos: async () => ({ videos: [] }),
  uploadAsset: async (_input: {
    file: File;
    durationSec: number;
    description: string;
  }): Promise<StudioProjectResponse> => unavailable("Asset upload"),
  generateCut: async (_input: unknown): Promise<StudioProjectResponse> =>
    unavailable("Timeline generation"),
  generateAsset: async (_input: {
    provider: string;
    kind: AssetKind;
    prompt?: string | null;
    description?: string | null;
    [key: string]: unknown;
  }): Promise<StudioProjectResponse> => unavailable("Asset generation"),
  reviseCut: async (_input: { message: string }): Promise<StudioProjectResponse> =>
    unavailable("Timeline revision"),
  exportTimeline: async (_input: unknown) => unavailable("Timeline export"),
  alignAudio: async (_input: unknown): Promise<StudioProjectResponse> =>
    unavailable("Audio alignment"),
};
