export const STUDIO_DRAFT_SCHEMA_VERSION = "studioDraft.v1" as const;
export const STUDIO_DRAFT_PAYLOAD_VERSION = 1 as const;

export type StudioDraftStep =
  | "brief"
  | "footage"
  | "story"
  | "generate"
  | "review"
  | "export";

export interface StudioDraftPayload {
  v: typeof STUDIO_DRAFT_PAYLOAD_VERSION;
  draft: Record<string, unknown>;
  step: StudioDraftStep;
  projectId?: string;
  runId?: string;
}

export interface StudioDraftSummary {
  id: string;
  schemaVersion: typeof STUDIO_DRAFT_SCHEMA_VERSION;
  workspaceId: string;
  displayExcerpt: string;
  step: StudioDraftStep;
  projectId?: string;
  runId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StudioDraft extends StudioDraftSummary {
  payload: StudioDraftPayload;
}

export interface StudioDraftListResponse {
  drafts: StudioDraftSummary[];
  pagination: {
    limit: number;
    nextCursor: string | null;
  };
}

export interface StudioDraftResponse {
  draft: StudioDraft;
}

export interface CreateStudioDraftRequest {
  payload: StudioDraftPayload;
}

export interface UpdateStudioDraftRequest {
  payload: StudioDraftPayload;
}
