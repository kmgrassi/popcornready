import { apiRequest, v1Api } from "./api-client";
import type { BriefDraft, StudioStep } from "../components/studio/useStudioFlow";
import type {
  CreateStudioDraftRequest,
  StudioDraftListResponse,
  StudioDraftPayload as WireStudioDraftPayload,
  StudioDraftResponse,
  UpdateStudioDraftRequest,
} from "@popcorn/shared/v1/studio-drafts";

export const STUDIO_DRAFT_PAYLOAD_VERSION = 1;

export interface StudioDraftPayload {
  v: typeof STUDIO_DRAFT_PAYLOAD_VERSION;
  draft: BriefDraft;
  step: StudioStep;
  projectId?: string;
  runId?: string;
}

export interface StudioDraftSummary {
  draftId: string;
  excerpt: string;
  step: StudioStep;
  updatedAt: string;
  projectId?: string;
  runId?: string;
}

export interface StudioDraftRecord extends StudioDraftSummary {
  payload: StudioDraftPayload;
}

const DEFAULT_BRIEF_DRAFT: BriefDraft = {
  goal: "",
  targetLengthSec: 30,
  aspectRatio: "9:16",
  projectName: "",
  footageChoice: "prompt_only",
  footageMode: "asset_driven",
  selectedFootage: [],
  audience: "",
  platform: "tiktok",
  format: "visual_reveal",
  hook: "",
  bestVisual: "",
  bigIdea: "",
  payoff: "",
  accuracyNote: "",
  style: "fast-paced social ad",
  callToAction: "",
  provider: "openai",
  seedKind: "image",
  seedSize: "1024x1792",
  showCaptions: true,
  reviewGates: [],
};

function workspacePath(workspaceId: string, suffix = ""): string {
  return `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/studio-drafts${suffix}`;
}

async function currentWorkspaceId(): Promise<string> {
  return (await v1Api.me()).workspaceId;
}

function normalizeStep(value: unknown): StudioStep {
  const steps: StudioStep[] = ["brief", "footage", "story", "generate", "review", "export"];
  return typeof value === "string" && steps.includes(value as StudioStep)
    ? (value as StudioStep)
    : "brief";
}

function sanitizeDraftForJson(draft: BriefDraft): BriefDraft {
  return {
    ...draft,
    selectedFootage: [],
  };
}

function buildPayload(
  draft: BriefDraft,
  step: StudioStep,
  ids: { projectId?: string; runId?: string } = {},
): StudioDraftPayload {
  return {
    v: STUDIO_DRAFT_PAYLOAD_VERSION,
    draft: sanitizeDraftForJson(draft),
    step,
    ...(ids.projectId ? { projectId: ids.projectId } : {}),
    ...(ids.runId ? { runId: ids.runId } : {}),
  };
}

function buildWirePayload(
  draft: BriefDraft,
  step: StudioStep,
  ids: { projectId?: string; runId?: string } = {},
): WireStudioDraftPayload {
  const payload = buildPayload(draft, step, ids);
  return {
    ...payload,
    draft: payload.draft as unknown as Record<string, unknown>,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function payloadFromUnknown(value: unknown): StudioDraftPayload | null {
  if (!isRecord(value) || value.v !== STUDIO_DRAFT_PAYLOAD_VERSION) return null;
  if (!isRecord(value.draft)) return null;

  return {
    v: STUDIO_DRAFT_PAYLOAD_VERSION,
    draft: {
      ...DEFAULT_BRIEF_DRAFT,
      ...(value.draft as Partial<BriefDraft>),
      selectedFootage: [],
    },
    step: normalizeStep(value.step),
    projectId: typeof value.projectId === "string" ? value.projectId : undefined,
    runId: typeof value.runId === "string" ? value.runId : undefined,
  };
}

function recordFromUnknown(value: unknown): StudioDraftRecord | null {
  if (!isRecord(value)) return null;
  const draftId =
    typeof value.draftId === "string"
      ? value.draftId
      : typeof value.id === "string"
        ? value.id
        : null;
  if (!draftId) return null;

  const payload = payloadFromUnknown(value.payload);
  const step = normalizeStep(value.step ?? payload?.step);
  const goal = payload?.draft.goal.trim();
  const excerpt =
    typeof value.excerpt === "string" && value.excerpt.trim()
      ? value.excerpt
      : typeof value.displayExcerpt === "string" && value.displayExcerpt.trim()
        ? value.displayExcerpt
        : goal || "Untitled draft";
  return {
    draftId,
    excerpt,
    step,
    updatedAt:
      typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
    projectId:
      typeof value.projectId === "string" ? value.projectId : payload?.projectId,
    runId: typeof value.runId === "string" ? value.runId : payload?.runId,
    payload:
      payload ??
      buildPayload(DEFAULT_BRIEF_DRAFT, step, {
        projectId: typeof value.projectId === "string" ? value.projectId : undefined,
        runId: typeof value.runId === "string" ? value.runId : undefined,
      }),
  };
}

async function readDraftRecord(response: Promise<StudioDraftResponse>): Promise<StudioDraftRecord> {
  const { draft } = await response;
  const record = recordFromUnknown(draft);
  if (!record) {
    throw new Error("The saved draft could not be read.");
  }
  return record;
}

export async function listDrafts(): Promise<StudioDraftSummary[]> {
  const workspaceId = await currentWorkspaceId();
  const { drafts } = await apiRequest<StudioDraftListResponse>(workspacePath(workspaceId), {
    method: "GET",
  });
  return drafts
    .map(recordFromUnknown)
    .filter((draft): draft is StudioDraftRecord => Boolean(draft))
    .map(({ payload: _payload, ...summary }) => summary);
}

export async function createDraft(
  draft: BriefDraft = DEFAULT_BRIEF_DRAFT,
  step: StudioStep = "brief",
): Promise<StudioDraftRecord> {
  const workspaceId = await currentWorkspaceId();
  const body: CreateStudioDraftRequest = { payload: buildWirePayload(draft, step) };
  return readDraftRecord(
    apiRequest<StudioDraftResponse>(workspacePath(workspaceId), {
      method: "POST",
      body,
    }),
  );
}

export async function loadDraft(draftId: string): Promise<StudioDraftRecord> {
  const workspaceId = await currentWorkspaceId();
  return readDraftRecord(
    apiRequest<StudioDraftResponse>(
      workspacePath(workspaceId, `/${encodeURIComponent(draftId)}`),
      { method: "GET" },
    ),
  );
}

export async function saveDraft(
  draftId: string,
  draft: BriefDraft,
  step: StudioStep,
  ids: { projectId?: string; runId?: string } = {},
): Promise<StudioDraftRecord> {
  const workspaceId = await currentWorkspaceId();
  const body: UpdateStudioDraftRequest = {
    payload: buildWirePayload(draft, step, ids),
  };
  return readDraftRecord(
    apiRequest<StudioDraftResponse>(
      workspacePath(workspaceId, `/${encodeURIComponent(draftId)}`),
      {
        method: "PUT",
        body,
      },
    ),
  );
}

export async function deleteDraft(draftId: string): Promise<void> {
  const workspaceId = await currentWorkspaceId();
  await apiRequest<void>(workspacePath(workspaceId, `/${encodeURIComponent(draftId)}`), {
    method: "DELETE",
  });
}
