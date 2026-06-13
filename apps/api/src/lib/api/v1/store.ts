// Persistence for the versioned agent API.
//
// This is a separate store from the single-project browser store (src/lib/store.ts).
// The agent API is multi-project and multi-workspace. This module is the ONLY
// place that talks to the database: routes/handlers call the exported functions
// below and never see SQL or supabase-js, so the storage backend can change here
// without touching anything upstream.
//
// Backend: Supabase Postgres (schema in supabase/migrations/20260603000000_init_v1_model.sql
// plus the public.users / workspace_members migrations). Reads/writes go through a
// service-role client (server-trusted); RLS still guards the tables against direct
// PostgREST access, and we keep explicit workspaceId/projectId tenancy filters on
// every query so a service-role bug can't silently cross tenants.
//
// Column ↔ object mapping notes:
//   * Tables use snake_case columns; objects use camelCase + a `schemaVersion` tag.
//   * Timestamps are normalized to canonical ISO (`new Date(x).toISOString()`) so
//     newest-first cursor pagination orders identically to the old JSON store.
//   * `assets` has dedicated columns for only a subset of V1Asset's fields; the
//     remaining context-family fields are packed into the `context` jsonb column
//     as a structured envelope (see assetContextEnvelope / unpackAssetContext).
//     `assets` stores METADATA only — the bytes live in storage (separate PR).

import { AsyncLocalStorage } from "async_hooks";
import { randomUUID } from "crypto";
import path from "path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { isMissingRow } from "../../supabase/db-errors";
import { iso, markedJson, throwOnError, unmarkedJson } from "./store-internal";
import {
  canonicalContentHash,
  graphInputsFromProvenance,
  inputsFingerprint,
  type GraphAssetInput,
} from "./asset-graph";
import {
  DASHBOARD_SCHEMA_VERSION,
  type DashboardSummary,
} from "@popcorn/shared/v1/dashboard";
import { ApiError, notFound } from "./errors";
import { GeneratedAssetProvenance } from "./provenance";
import { AssetSemanticAnalysis } from "../../edit-graph/types";
import {
  type CompositionPlan as ContractCompositionPlan,
  type GenerationRun,
  type GenerationRunStatus,
  type Job,
  type JobStatus,
  type JobType,
  type ProjectStoryboard,
  type StoryboardBeat,
  type StoryboardItemStatus,
  type StoryboardPanel,
  type StoryboardScene,
  type StoryboardStatus,
  SCHEMA as CONTRACT_SCHEMA,
} from "@popcorn/shared/v1/types";
import {
  STUDIO_DRAFT_SCHEMA_VERSION,
  type StudioDraft,
  type StudioDraftPayload,
  type StudioDraftStep,
  type StudioDraftSummary,
} from "@popcorn/shared/v1/studio-drafts";
import {
  getGenerationRunStore,
  type GenerationRunsStore,
} from "../../v1/generation-runs/store";
import { getRequestSupabase } from "../../supabase/clients";
import { agentApiStore, type AgentApiStore } from "../../agent-api/jobs";
import { resolveAssetUrl } from "../../storage/asset-urls";
import {
  AgentAssetSource,
  AgentAssetContext,
  AgentClipContext,
  AssetContext,
  AssetKnowledge,
  AssetKind,
  SCHEMA_VERSIONS,
  UserAssetContext,
  VideoBrief,
} from "./schemas";
import {
  reconcileAssetStorage,
  type VisibilityObjectStore,
} from "../../storage/visibility-move";

export interface V1Workspace {
  id: string;
  schemaVersion: typeof SCHEMA_VERSIONS.workspace;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface V1Project {
  id: string;
  schemaVersion: typeof SCHEMA_VERSIONS.project;
  workspaceId: string;
  name: string;
  status: "active" | "deleted";
  visibility?: "public" | "private";
  brief: VideoBrief | null;
  currentBriefVersionId: string | null;
  hasStoryboard?: boolean;
  posterAssetId: string | null;
  posterUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface V1BriefVersion {
  id: string;
  schemaVersion: typeof SCHEMA_VERSIONS.briefVersion;
  projectId: string;
  brief: VideoBrief;
  createdAt: string;
}

export interface V1Asset {
  id: string;
  schemaVersion: typeof SCHEMA_VERSIONS.asset;
  workspaceId: string;
  projectId: string;
  kind: AssetKind;
  filename: string;
  status: "ready" | "pending";
  source: AgentAssetSource;
  visibility?: "public" | "private";
  remoteUrl?: string;
  storageKey?: string;
  storageBucket?: string;
  durationSec?: number;
  context?: AssetContext;
  userContext?: UserAssetContext;
  agentContext?: AgentAssetContext | AgentClipContext;
  assetKnowledge?: AssetKnowledge;
  clipUnderstanding?: {
    assetId: string;
    source: "upload" | "generated";
    combinedSummary: string;
    timelineHints: {
      mustUse: boolean;
      avoid: boolean;
      preferredBeats: string[];
      bestStartSec?: number;
      bestEndSec?: number;
    };
    provenance: {
      userContextUpdatedAt?: string;
      analyzedAt?: string;
      analysisVersion: string;
      sampledFrameAssetIds: string[];
    };
  };
  semanticAnalysis?: AssetSemanticAnalysis;
  analysis?: V1AssetAnalysis;
  // Present for assets produced by the generated-assets endpoint (PR2).
  provenance?: GeneratedAssetProvenance;
  graphInputs?: GraphAssetInput[];
  contentHash?: string;
  inputsFingerprint?: string;
  createdAt: string;
  updatedAt: string;
}

export interface V1AssetAnalysis {
  schemaVersion: "assetAnalysis.v1";
  status: "succeeded" | "failed";
  analyzedAt: string;
  analysisVersion: string;
  sampledFrames: string[];
  observations?: {
    summary: string;
    subjects: string[];
    actions: string[];
    setting?: string;
    mood?: string;
    likelyUses: string[];
    cautions: string[];
    confidence: "low" | "medium" | "high";
    model: {
      provider: string;
      model?: string;
    };
  };
  error?: {
    code: string;
    message: string;
  };
}

export interface IdempotencyRecord {
  scope: string;
  key: string;
  bodyHash: string;
  status: number;
  responseBody: unknown;
  createdAt: string;
}

export interface AssetGraphSelectionRef {
  slotOwnerLineageId: string | null;
  slotRole: string;
  seq: number;
}

export interface StaleCandidateAsset {
  assetId: string;
  depth: number;
  ref: string | null;
  kind: string;
  status: string;
  role: string | null;
  lineageId: string;
  version: number;
  contentHash: string | null;
  inputsFingerprint: string | null;
  selections: AssetGraphSelectionRef[];
}

export interface StaleCandidatesResult {
  changedAsset: {
    assetId: string;
    ref: string | null;
    kind: string;
    contentHash: string | null;
  };
  candidates: StaleCandidateAsset[];
}

export type ActionStatus =
  | "proposed"
  | "approved"
  | "rejected"
  | "running"
  | "applied"
  | "failed";

export interface V1Action {
  id: string;
  schemaVersion: "action.v1";
  projectId: string;
  runId?: string;
  tool: string;
  status: ActionStatus;
  params: Record<string, unknown>;
  inputAssetIds: string[];
  rationale?: string;
  proposal?: Record<string, unknown>;
  estimatedCostUsd?: number;
  actualCostUsd?: number;
  jobIds: string[];
  outputAssetIds: string[];
  error?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateActionInput {
  projectId: string;
  runId?: string;
  orchestratorRunId?: string;
  tool: string;
  status?: ActionStatus;
  params?: Record<string, unknown>;
  inputAssetIds?: string[];
  rationale?: string;
  proposal?: Record<string, unknown>;
  estimatedCostUsd?: number;
  actualCostUsd?: number;
  jobIds?: string[];
  outputAssetIds?: string[];
  error?: Record<string, unknown>;
}

export type UpdateActionPatch = Partial<
  Pick<
    V1Action,
    "status" | "estimatedCostUsd" | "actualCostUsd" | "jobIds" | "outputAssetIds" | "error"
  >
>;

// ---------------------------------------------------------------------------
// Local media paths (asset BYTES, not DB rows)
// ---------------------------------------------------------------------------
// These compute on-disk paths for uploaded/generated media bytes. They are
// orthogonal to the Postgres metadata store below and are still consumed by the
// asset byte/storage code (assets.ts / generated-assets.ts / jobs.ts), which a
// separate storage PR owns. Kept here so this module's exported surface stays a
// superset and nothing upstream needs to change.
const localDirContext = new AsyncLocalStorage<string>();

// Resolved per call so tests can point POPCORN_READY_LOCAL_DIR at a temp directory.
export function localDir(): string {
  const contextualDir = localDirContext.getStore();
  if (contextualDir) return contextualDir;
  return process.env.POPCORN_READY_LOCAL_DIR || path.join(process.cwd(), ".local");
}

export function withLocalDir<T>(dir: string, fn: () => T): T {
  return localDirContext.run(dir, fn);
}

export function mediaUploadDir(workspaceId: string, projectId: string): string {
  return path.join(localDir(), "media", "uploads", workspaceId, projectId);
}

export function mediaGeneratedDir(workspaceId: string, projectId: string): string {
  return path.join(localDir(), "media", "generated", workspaceId, projectId);
}

export function mediaAnalysisDir(
  workspaceId: string,
  projectId: string,
  assetId: string
): string {
  return path.join(localDir(), "media", "analysis", workspaceId, projectId, assetId);
}

// ---------------------------------------------------------------------------
// Service-role Supabase client
// ---------------------------------------------------------------------------
// TODO: replace with the shared clients.ts from the auth-middleware PR. That PR
// owns apps/api/src/lib/supabase/clients.ts; until it lands, this module keeps a
// minimal local service-role helper so it has no cross-PR import dependency. The
// service-role key bypasses RLS, which is why every query below still filters on
// workspaceId/projectId explicitly (tenancy is enforced in app code, not relied
// on from RLS).
let serviceClient: SupabaseClient | null = null;

export class StoreConfigError extends Error {
  constructor(missing: string[]) {
    super(
      `Supabase store is not configured: ${missing.join(", ")} ${
        missing.length === 1 ? "is" : "are"
      } required.`
    );
    this.name = "StoreConfigError";
  }
}

function getServiceSupabase(): SupabaseClient {
  if (serviceClient) return serviceClient;

  const url = (process.env.SUPABASE_URL ?? "").trim().replace(/\/$/, "");
  const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();

  const missing: string[] = [];
  if (!url) missing.push("SUPABASE_URL");
  if (!serviceRoleKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (missing.length > 0) throw new StoreConfigError(missing);

  serviceClient = createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
  return serviceClient;
}

function getRequestSupabaseOrService(): SupabaseClient {
  try {
    return getRequestSupabase();
  } catch {
    return getServiceSupabase();
  }
}

// ---------------------------------------------------------------------------
// Helpers: timestamps, errors, mapping
// ---------------------------------------------------------------------------

// Normalize a DB timestamptz (or any date-ish value) to canonical ISO so cursor
// pagination ordering is stable across the JSON-string and Postgres backends.
// supabase-js returns `PGRST116` when a `.single()` lookup matches no rows.
// Callers translate that into notFound/null; other DB failures use the typed
// database_error envelope instead of leaking as generic internal errors.
// iso/throwOnError/markedJson/unmarkedJson now live in ./store-internal.
const isNoRows = isMissingRow;

export async function defaultVisibilityForWorkspace(
  db: SupabaseClient,
  workspaceId: string
): Promise<"public" | "private"> {
  const { data, error } = await db.rpc("owner_tier", { ws_id: workspaceId });
  throwOnError(error, "defaultVisibilityForWorkspace");
  return data === "paid" ? "private" : "public";
}

export async function effectiveAssetStorageVisibility(input: {
  workspaceId: string;
  projectId: string;
  assetVisibility: "public" | "private";
}): Promise<"public" | "private"> {
  if (input.assetVisibility === "private") return "private";
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("projects")
    .select("visibility")
    .eq("id", input.projectId)
    .eq("workspace_id", input.workspaceId)
    .maybeSingle();
  if (isNoRows(error)) throw notFound(`Project not found: ${input.projectId}`);
  throwOnError(error, "effectiveAssetStorageVisibility project");
  const row = data as { visibility?: "public" | "private" } | null;
  if (!row) throw notFound(`Project not found: ${input.projectId}`);
  return row.visibility === "private" ? "private" : "public";
}

// --- workspaces ------------------------------------------------------------
interface WorkspaceRow {
  id: string;
  schema_version: string;
  owner_id: string | null;
  name: string;
  created_at: string;
  updated_at: string;
}

function mapWorkspace(row: WorkspaceRow): V1Workspace {
  return {
    id: row.id,
    schemaVersion: SCHEMA_VERSIONS.workspace,
    name: row.name,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

// --- projects --------------------------------------------------------------
interface ProjectRow {
  id: string;
  schema_version: string;
  workspace_id: string;
  name: string;
  status: "active" | "deleted";
  visibility?: "public" | "private";
  created_at: string;
  updated_at: string;
}

function mapProject(
  row: ProjectRow,
  projection: {
    brief?: VideoBrief | null;
    currentBriefVersionId?: string | null;
    hasStoryboard?: boolean;
    posterAssetId?: string | null;
    posterUrl?: string | null;
  } = {}
): V1Project {
  return {
    id: row.id,
    schemaVersion: SCHEMA_VERSIONS.project,
    workspaceId: row.workspace_id,
    name: row.name,
    status: row.status,
    visibility: row.visibility,
    brief: projection.brief ?? null,
    currentBriefVersionId: projection.currentBriefVersionId ?? null,
    hasStoryboard: projection.hasStoryboard ?? false,
    posterAssetId: projection.posterAssetId ?? null,
    posterUrl: projection.posterUrl ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

// --- brief versions --------------------------------------------------------
interface DataAssetRow {
  id: string;
  schema_version: string;
  workspace_id: string;
  project_id: string;
  lineage_id: string;
  version: number;
  kind: GraphAssetKind;
  media: AssetMedia;
  status: "ready" | "pending";
  role: string | null;
  content: unknown;
  content_hash: string | null;
  inputs_fingerprint: string | null;
  created_at: string;
  updated_at: string;
}

// Typed-JSONB guardrail (assets_content_schema_check / assets_params_schema_check):
// jsonb document payloads must carry a schema marker. Stamp it on write, strip
// it when projecting the payload back out as a domain object.
const CONTENT_SCHEMA_KEY = "schema_version";

function markedContent(kind: "brief" | "beat", content: unknown): Record<string, unknown> {
  return { [CONTENT_SCHEMA_KEY]: `${kind}.v1`, ...(content as Record<string, unknown>) };
}

function unmarkedContent<T>(content: unknown): T {
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const { [CONTENT_SCHEMA_KEY]: _schema, ...rest } = content as Record<string, unknown>;
    return rest as T;
  }
  return content as T;
}

function mapBriefVersion(row: DataAssetRow): V1BriefVersion {
  return {
    id: row.id,
    schemaVersion: SCHEMA_VERSIONS.briefVersion,
    projectId: row.project_id,
    brief: unmarkedContent<VideoBrief>(row.content),
    createdAt: iso(row.created_at),
  };
}

interface CurrentSelectionRow {
  active_asset_id: string;
}

interface GraphAssetSummaryRow {
  id: string;
  ref: string | null;
  kind: string;
  status: string;
  role: string | null;
  lineage_id: string;
  version: number;
  content_hash: string | null;
  inputs_fingerprint: string | null;
}

interface DownstreamAssetRow {
  asset_id: string;
  depth: number;
}

interface CurrentSelectionSummaryRow {
  slot_owner_lineage_id: string | null;
  slot_role: string;
  seq: number;
  active_asset_id: string;
}

interface ActionRow {
  id: string;
  schema_version: "action.v1";
  project_id: string;
  run_id: string | null;
  tool: string;
  status: ActionStatus;
  params: Record<string, unknown>;
  input_asset_ids: string[];
  rationale: string | null;
  proposal: Record<string, unknown> | null;
  estimated_cost_usd: number | null;
  actual_cost_usd: number | null;
  job_ids: string[];
  output_asset_ids: string[];
  error: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

interface RunBudgetRow {
  id: string;
  project_id: string;
  budget_usd: number | null;
}

interface AssetFingerprintRow {
  id: string;
  content_hash: string | null;
  inputs_fingerprint: string | null;
}

function mapAction(row: ActionRow): V1Action {
  const action: V1Action = {
    id: row.id,
    schemaVersion: "action.v1",
    projectId: row.project_id,
    tool: row.tool,
    status: row.status,
    params: unmarkedJson(row.params) ?? {},
    inputAssetIds: row.input_asset_ids ?? [],
    jobIds: row.job_ids ?? [],
    outputAssetIds: row.output_asset_ids ?? [],
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
  if (row.run_id != null) action.runId = row.run_id;
  if (row.rationale != null) action.rationale = row.rationale;
  const proposal = unmarkedJson(row.proposal);
  if (proposal) action.proposal = proposal;
  if (row.estimated_cost_usd != null) action.estimatedCostUsd = row.estimated_cost_usd;
  if (row.actual_cost_usd != null) action.actualCostUsd = row.actual_cost_usd;
  const error = unmarkedJson(row.error);
  if (error) action.error = error;
  return action;
}

async function dataAssetById(
  db: SupabaseClient,
  assetId: string
): Promise<DataAssetRow | null> {
  const { data, error } = await db
    .from("assets")
    .select("*")
    .eq("id", assetId)
    .eq("media", "data")
    .maybeSingle();
  if (isNoRows(error)) return null;
  throwOnError(error, "dataAssetById");
  return (data as DataAssetRow | null) ?? null;
}

async function latestDataAsset(
  db: SupabaseClient,
  projectId: string,
  kind: GraphAssetKind
): Promise<DataAssetRow | null> {
  const { data, error } = await db
    .from("assets")
    .select("*")
    .eq("project_id", projectId)
    .eq("kind", kind)
    .eq("media", "data")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (isNoRows(error)) return null;
  throwOnError(error, `latestDataAsset ${kind}`);
  return (data as DataAssetRow | null) ?? null;
}

async function selectedDataAsset(
  db: SupabaseClient,
  projectId: string,
  slotRole: string,
  kind: GraphAssetKind
): Promise<DataAssetRow | null> {
  const selected = await db
    .from("current_selections")
    .select("active_asset_id")
    .eq("project_id", projectId)
    .eq("slot_role", slotRole)
    .maybeSingle();
  if (isNoRows(selected.error)) return latestDataAsset(db, projectId, kind);
  throwOnError(selected.error, `selectedDataAsset ${slotRole}`);

  const activeAssetId = (selected.data as CurrentSelectionRow | null)?.active_asset_id;
  if (!activeAssetId) return latestDataAsset(db, projectId, kind);
  return (await dataAssetById(db, activeAssetId)) ?? latestDataAsset(db, projectId, kind);
}

// --- poster ----------------------------------------------------------------
// The project's marketing one-sheet, shown as the thumbnail in dashboard
// grids. The current poster is the project-scoped 'poster' selection slot
// (slot_owner_lineage_id null). Until one is selected or generated, fall back
// to the newest ready poster-kind asset, then the newest ready image of any
// kind, so project grids stay visual from the first keyframe onward.
//
// Public projections (unauthenticated discover) must pass publicOnly so a
// private selected poster or private fallback image never leaks a signed URL;
// a private selection falls through to public-only candidates instead.
const POSTER_SLOT_ROLE = "poster";

interface PosterAssetRow {
  id: string;
  media: AssetMedia;
  status: "ready" | "pending";
  remote_url: string | null;
  storage_key: string | null;
  storage_bucket: string | null;
  visibility: "public" | "private" | null;
}

const POSTER_ASSET_COLUMNS =
  "id, media, status, remote_url, storage_key, storage_bucket, visibility";

interface PosterVisibilityOpts {
  publicOnly?: boolean;
}

async function readyImageAssetById(
  db: SupabaseClient,
  projectId: string,
  assetId: string,
  opts: PosterVisibilityOpts = {}
): Promise<PosterAssetRow | null> {
  let query = db
    .from("assets")
    .select(POSTER_ASSET_COLUMNS)
    .eq("project_id", projectId)
    .eq("id", assetId)
    .eq("media", "image")
    .eq("status", "ready");
  if (opts.publicOnly) query = query.eq("visibility", "public");
  const { data, error } = await query.maybeSingle();
  if (isNoRows(error)) return null;
  throwOnError(error, "readyImageAssetById");
  return (data as PosterAssetRow | null) ?? null;
}

async function latestReadyImageAsset(
  db: SupabaseClient,
  projectId: string,
  kind?: GraphAssetKind,
  opts: PosterVisibilityOpts = {}
): Promise<PosterAssetRow | null> {
  let query = db
    .from("assets")
    .select(POSTER_ASSET_COLUMNS)
    .eq("project_id", projectId)
    .eq("media", "image")
    .eq("status", "ready");
  if (kind) query = query.eq("kind", kind);
  if (opts.publicOnly) query = query.eq("visibility", "public");
  const { data, error } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (isNoRows(error)) return null;
  throwOnError(error, `latestReadyImageAsset ${kind ?? "image"}`);
  return (data as PosterAssetRow | null) ?? null;
}

async function projectPosterAsset(
  db: SupabaseClient,
  projectId: string,
  opts: PosterVisibilityOpts = {}
): Promise<PosterAssetRow | null> {
  const selected = await db
    .from("current_selections")
    .select("active_asset_id")
    .eq("project_id", projectId)
    .is("slot_owner_lineage_id", null)
    .eq("slot_role", POSTER_SLOT_ROLE)
    .maybeSingle();
  if (!isNoRows(selected.error)) {
    throwOnError(selected.error, "projectPosterAsset selection");
  }
  const activeAssetId = (selected.data as CurrentSelectionRow | null)?.active_asset_id;
  if (activeAssetId) {
    const asset = await readyImageAssetById(db, projectId, activeAssetId, opts);
    if (asset) return asset;
  }
  return (
    (await latestReadyImageAsset(db, projectId, "poster", opts)) ??
    (await latestReadyImageAsset(db, projectId, undefined, opts))
  );
}

// Browser-usable URL for a poster asset. Uses the same storage resolver as the
// asset payload mapper so public/private delivery stays consistent.
async function posterUrlFor(asset: PosterAssetRow | null): Promise<string | null> {
  if (!asset) return null;
  return (await resolveAssetUrl(asset)) ?? null;
}

async function projectProjection(
  db: SupabaseClient,
  projectId: string,
  opts: PosterVisibilityOpts = {}
): Promise<{
  brief: VideoBrief | null;
  currentBriefVersionId: string | null;
  hasStoryboard: boolean;
  posterAssetId: string | null;
  posterUrl: string | null;
}> {
  const [briefAsset, storyboard, posterAsset] = await Promise.all([
    selectedDataAsset(db, projectId, "brief", "brief"),
    db
      .from("storyboards")
      .select("id")
      .eq("project_id", projectId)
      .limit(1)
      .maybeSingle(),
    projectPosterAsset(db, projectId, opts),
  ]);
  const poster = {
    posterAssetId: posterAsset?.id ?? null,
    posterUrl: await posterUrlFor(posterAsset),
  };
  if (isNoRows(storyboard.error)) {
    return {
      brief: briefAsset ? unmarkedContent<VideoBrief>(briefAsset.content) : null,
      currentBriefVersionId: briefAsset?.id ?? null,
      hasStoryboard: false,
      ...poster,
    };
  }
  throwOnError(storyboard.error, "projectProjection storyboard");
  return {
    brief: briefAsset ? unmarkedContent<VideoBrief>(briefAsset.content) : null,
    currentBriefVersionId: briefAsset?.id ?? null,
    hasStoryboard: Boolean(storyboard.data),
    ...poster,
  };
}

async function mapProjectWithProjection(
  db: SupabaseClient,
  row: ProjectRow,
  opts: PosterVisibilityOpts = {}
): Promise<V1Project> {
  return mapProject(row, await projectProjection(db, row.id, opts));
}

async function setActiveAssetSelection(
  db: SupabaseClient,
  projectId: string,
  slotRole: "brief" | typeof POSTER_SLOT_ROLE,
  activeAssetId: string,
  setByActionId?: string
): Promise<void> {
  const { error } = await db
    .from("selections")
    .insert({
      project_id: projectId,
      slot_owner_lineage_id: null,
      slot_role: slotRole,
      active_asset_id: activeAssetId,
      set_by_action_id: setByActionId ?? null,
    });
  throwOnError(error, `setActiveAssetSelection ${slotRole}`);
}

export async function createAction(input: CreateActionInput): Promise<V1Action> {
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("actions")
    .insert({
      schema_version: "action.v1",
      project_id: input.projectId,
      run_id: input.runId ?? null,
      orchestrator_run_id: input.orchestratorRunId ?? null,
      tool: input.tool,
      status: input.status ?? "proposed",
      params: markedJson("action_params.v1", input.params ?? {}) ?? {},
      input_asset_ids: input.inputAssetIds ?? [],
      rationale: input.rationale ?? null,
      proposal: markedJson("action_proposal.v1", input.proposal) ?? null,
      estimated_cost_usd: input.estimatedCostUsd ?? null,
      actual_cost_usd: input.actualCostUsd ?? null,
      job_ids: input.jobIds ?? [],
      output_asset_ids: input.outputAssetIds ?? [],
      error: markedJson("action_error.v1", input.error) ?? null,
    })
    .select("*")
    .single();
  throwOnError(error, `createAction ${input.tool}`);
  return mapAction(data as ActionRow);
}

export async function updateAction(
  actionId: string,
  patch: UpdateActionPatch
): Promise<V1Action> {
  const row: Record<string, unknown> = {};
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.estimatedCostUsd !== undefined) {
    row.estimated_cost_usd = patch.estimatedCostUsd;
  }
  if (patch.actualCostUsd !== undefined) row.actual_cost_usd = patch.actualCostUsd;
  if (patch.jobIds !== undefined) row.job_ids = patch.jobIds;
  if (patch.outputAssetIds !== undefined) row.output_asset_ids = patch.outputAssetIds;
  if (patch.error !== undefined) row.error = markedJson("action_error.v1", patch.error) ?? null;

  const db = getServiceSupabase();
  const { data, error } = await db
    .from("actions")
    .update(row)
    .eq("id", actionId)
    .select("*")
    .single();
  throwOnError(error, `updateAction ${actionId}`);
  return mapAction(data as ActionRow);
}

export async function assertRunBudgetAllows(input: {
  runId?: string;
  projectId: string;
  additionalCostUsd: number;
}): Promise<void> {
  if (!input.runId) return;
  const db = getServiceSupabase();
  const { data: run, error: runError } = await db
    .from("generation_runs")
    .select("id,project_id,budget_usd")
    .eq("id", input.runId)
    .maybeSingle();
  if (isNoRows(runError)) {
    throw new Error(`Run not found: ${input.runId}`);
  }
  throwOnError(runError, "assertRunBudgetAllows run");

  const scopedRun = run as RunBudgetRow | null;
  if (!scopedRun) throw new Error(`Run not found: ${input.runId}`);
  if (scopedRun.project_id !== input.projectId) {
    throw new Error(`Run project mismatch: ${input.runId}`);
  }

  const budgetUsd = scopedRun.budget_usd;
  if (budgetUsd == null || budgetUsd <= 0) return;

  const { data: actions, error: actionsError } = await db
    .from("actions")
    .select("estimated_cost_usd,actual_cost_usd,status")
    .eq("run_id", input.runId)
    .in("status", ["proposed", "approved", "running", "applied"]);
  throwOnError(actionsError, "assertRunBudgetAllows actions");

  const committedUsd = ((actions as Pick<
    ActionRow,
    "estimated_cost_usd" | "actual_cost_usd" | "status"
  >[]) ?? []).reduce((sum, action) => {
    return sum + (action.actual_cost_usd ?? action.estimated_cost_usd ?? 0);
  }, 0);
  if (committedUsd + input.additionalCostUsd > budgetUsd) {
    throw new Error(
      `Run budget exceeded: ${committedUsd + input.additionalCostUsd} exceeds ${budgetUsd}.`
    );
  }
}

export async function getAssetFingerprintPins(
  projectId: string,
  assetIds: string[]
): Promise<Record<string, string>> {
  const uniqueIds = [...new Set(assetIds)].filter(Boolean);
  if (uniqueIds.length === 0) return {};
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("assets")
    .select("id,content_hash,inputs_fingerprint")
    .eq("project_id", projectId)
    .in("id", uniqueIds);
  throwOnError(error, "getAssetFingerprintPins");
  const pins: Record<string, string> = {};
  for (const row of ((data as AssetFingerprintRow[]) ?? [])) {
    const fingerprint = row.inputs_fingerprint ?? row.content_hash;
    if (fingerprint) pins[row.id] = fingerprint;
  }
  return pins;
}

async function insertDataAsset(input: {
  db: SupabaseClient;
  workspaceId: string;
  projectId: string;
  kind: "brief" | "beat";
  role: string;
  content: unknown;
  lineageId?: string;
  version?: number;
  createdByActionId?: string;
}): Promise<DataAssetRow> {
  const now = new Date().toISOString();
  const visibility = await defaultVisibilityForWorkspace(input.db, input.workspaceId);
  const content = markedContent(input.kind, input.content);
  const row: Record<string, unknown> = {
    schema_version: "asset.v2",
    workspace_id: input.workspaceId,
    project_id: input.projectId,
    kind: input.kind,
    media: "data",
    status: "ready",
    role: input.role,
    content,
    content_hash: canonicalContentHash(content),
    inputs_fingerprint: inputsFingerprint([], null),
    visibility,
    created_at: now,
    updated_at: now,
  };
  if (input.createdByActionId) row.created_by_action_id = input.createdByActionId;
  if (input.lineageId) row.lineage_id = input.lineageId;
  if (input.version) row.version = input.version;

  const { data, error } = await input.db
    .from("assets")
    .insert(row)
    .select("*")
    .single();
  throwOnError(error, `insertDataAsset ${input.kind}`);
  return data as DataAssetRow;
}

// --- studio drafts ---------------------------------------------------------
interface StudioDraftRow {
  id: string;
  schema_version: string;
  workspace_id: string;
  owner_user_id: string | null;
  local_actor_id: string | null;
  payload: StudioDraftPayload;
  display_excerpt: string;
  step: StudioDraftStep;
  project_id: string | null;
  run_id: string | null;
  created_at: string;
  updated_at: string;
}

function mapStudioDraftSummary(row: StudioDraftRow): StudioDraftSummary {
  return {
    id: row.id,
    schemaVersion: STUDIO_DRAFT_SCHEMA_VERSION,
    workspaceId: row.workspace_id,
    displayExcerpt: row.display_excerpt,
    step: row.step,
    projectId: row.project_id ?? undefined,
    runId: row.run_id ?? undefined,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapStudioDraft(row: StudioDraftRow): StudioDraft {
  return {
    ...mapStudioDraftSummary(row),
    payload: row.payload,
  };
}

export function displayExcerptForStudioDraft(payload: StudioDraftPayload): string {
  const goal = payload.draft.goal;
  if (typeof goal !== "string") return "Untitled draft";
  const compact = goal.trim().replace(/\s+/g, " ");
  if (!compact) return "Untitled draft";
  return compact.length > 96 ? `${compact.slice(0, 93).trimEnd()}...` : compact;
}

async function assertStudioDraftRefs(
  workspaceId: string,
  payload: StudioDraftPayload
): Promise<void> {
  if (payload.projectId) {
    await getProject(workspaceId, payload.projectId);
  }
  if (payload.runId) {
    const run = await getGenerationRunStore().getRun(payload.runId);
    if (!run) throw notFound(`Generation run not found: ${payload.runId}`);
    await getProject(workspaceId, run.projectId);
    if (payload.projectId && payload.projectId !== run.projectId) {
      throw notFound(`Generation run not found: ${payload.runId}`);
    }
  }
}

// --- assets ----------------------------------------------------------------
// The assets table has dedicated columns for a subset of V1Asset. The
// context-family fields (context/userContext/agentContext/assetKnowledge/
// clipUnderstanding) share the single `context` jsonb column via this envelope
// so nothing is lost on round-trip.
interface AssetContextEnvelope {
  context?: AssetContext;
  userContext?: UserAssetContext;
  agentContext?: AgentAssetContext | AgentClipContext;
  assetKnowledge?: AssetKnowledge;
  clipUnderstanding?: V1Asset["clipUnderstanding"];
  analysis?: V1AssetAnalysis;
}

type GraphAssetKind =
  | "source_footage"
  | "brief"
  | "beat"
  | "anchor"
  | "keyframe"
  | "clip"
  | "audio_track"
  | "narration_script"
  | "critique"
  | "plan"
  | "composite"
  | "render"
  | "poster";

type AssetMedia = "data" | "image" | "video" | "audio";

interface AssetRow {
  id: string;
  schema_version: string;
  workspace_id: string;
  project_id: string;
  kind: GraphAssetKind;
  media: AssetMedia;
  status: "ready" | "pending";
  filename: string;
  content: unknown | null;
  params: { schema_version?: string; provenance?: GeneratedAssetProvenance } | null;
  inputs: GraphAssetInput[];
  content_hash: string | null;
  inputs_fingerprint: string | null;
  remote_url: string | null;
  storage_key: string | null;
  storage_bucket: string | null;
  source: AgentAssetSource;
  duration_sec: number | null;
  description: string | null;
  context: AssetContextEnvelope | null;
  semantic_analysis: AssetSemanticAnalysis | null;
  created_by_action_id?: string | null;
  visibility?: "public" | "private";
  created_at: string;
  updated_at: string;
}

function assetKindToGraphKind(asset: V1Asset): GraphAssetKind {
  if (asset.kind === "audio") return "audio_track";
  if (asset.kind === "image") return asset.provenance ? "keyframe" : "anchor";
  return asset.provenance ? "clip" : "source_footage";
}

function assetMediaToKind(media: AssetMedia, kind: GraphAssetKind): AssetKind {
  if (media === "image" || media === "video" || media === "audio") return media;
  if (kind === "audio_track") return "audio";
  if (kind === "anchor" || kind === "keyframe") return "image";
  return "video";
}

function assetContextEnvelope(asset: V1Asset): AssetContextEnvelope | null {
  const envelope: AssetContextEnvelope = {};
  if (asset.context !== undefined) envelope.context = asset.context;
  if (asset.userContext !== undefined) envelope.userContext = asset.userContext;
  if (asset.agentContext !== undefined) envelope.agentContext = asset.agentContext;
  if (asset.assetKnowledge !== undefined) envelope.assetKnowledge = asset.assetKnowledge;
  if (asset.clipUnderstanding !== undefined) {
    envelope.clipUnderstanding = asset.clipUnderstanding;
  }
  if (asset.analysis !== undefined) envelope.analysis = asset.analysis;
  return Object.keys(envelope).length > 0 ? envelope : null;
}

function assetToRow(asset: V1Asset): AssetRow {
  const params = asset.provenance
    ? { schema_version: "asset_params.v1", provenance: asset.provenance }
    : null;
  return {
    id: asset.id,
    schema_version: asset.schemaVersion,
    workspace_id: asset.workspaceId,
    project_id: asset.projectId,
    kind: assetKindToGraphKind(asset),
    media: asset.kind,
    status: asset.status,
    filename: asset.filename,
    content: null,
    params,
    inputs: asset.graphInputs ?? [],
    content_hash: asset.contentHash ?? null,
    inputs_fingerprint:
      asset.inputsFingerprint ??
      (asset.graphInputs !== undefined || params
        ? inputsFingerprint(asset.graphInputs ?? [], params)
        : null),
    remote_url: asset.remoteUrl ?? null,
    storage_key: asset.storageKey ?? null,
    storage_bucket: asset.storageBucket ?? null,
    source: asset.source,
    duration_sec: asset.durationSec ?? null,
    description: asset.userContext?.description ?? asset.context?.summary ?? null,
    context: assetContextEnvelope(asset),
    semantic_analysis: asset.semanticAnalysis ?? null,
    created_at: asset.createdAt,
    updated_at: asset.updatedAt,
  };
}

async function contentHashesForAssets(
  db: SupabaseClient,
  projectId: string,
  assetIds: string[]
): Promise<Map<string, string | null>> {
  const uniqueIds = [...new Set(assetIds)].filter(Boolean);
  if (uniqueIds.length === 0) return new Map();

  const { data, error } = await db
    .from("assets")
    .select("id, content_hash")
    .eq("project_id", projectId)
    .in("id", uniqueIds);
  throwOnError(error, "contentHashesForAssets");

  const rows = (data ?? []) as Array<{ id: string; content_hash: string | null }>;
  return new Map(rows.map((row) => [row.id, row.content_hash]));
}

async function withGraphMetadataForInsert(
  db: SupabaseClient,
  asset: V1Asset
): Promise<V1Asset> {
  if (!asset.provenance && asset.graphInputs === undefined) return asset;

  const provenanceAssetIds = [
    ...(asset.provenance?.referenceAssetIds ?? []),
    ...(asset.provenance?.anchorIds ?? []),
  ];
  const existingInputIds = asset.graphInputs?.map((input) => input.assetId) ?? [];
  const contentHashByAssetId = await contentHashesForAssets(db, asset.projectId, [
    ...provenanceAssetIds,
    ...existingInputIds,
  ]);
  const graphInputs =
    asset.graphInputs ??
    graphInputsFromProvenance(asset.provenance, contentHashByAssetId);

  const params = asset.provenance
    ? { schema_version: "asset_params.v1", provenance: asset.provenance }
    : null;
  return {
    ...asset,
    graphInputs,
    inputsFingerprint: asset.inputsFingerprint ?? inputsFingerprint(graphInputs, params),
  };
}

function mapAssetRow(row: AssetRow): V1Asset {
  const envelope = row.context ?? {};
  const asset: V1Asset = {
    id: row.id,
    schemaVersion: SCHEMA_VERSIONS.asset,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    kind: assetMediaToKind(row.media, row.kind),
    filename: row.filename,
    status: row.status,
    source: row.source,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
  if (row.remote_url != null) asset.remoteUrl = row.remote_url;
  if (row.storage_key != null) asset.storageKey = row.storage_key;
  if (row.storage_bucket != null) asset.storageBucket = row.storage_bucket;
  if (row.duration_sec != null) asset.durationSec = row.duration_sec;
  if (envelope.context !== undefined) asset.context = envelope.context;
  if (envelope.userContext !== undefined) asset.userContext = envelope.userContext;
  if (envelope.agentContext !== undefined) asset.agentContext = envelope.agentContext;
  if (envelope.assetKnowledge !== undefined) asset.assetKnowledge = envelope.assetKnowledge;
  if (envelope.clipUnderstanding !== undefined) {
    asset.clipUnderstanding = envelope.clipUnderstanding;
  }
  if (envelope.analysis !== undefined) asset.analysis = envelope.analysis;
  if (row.semantic_analysis != null) asset.semanticAnalysis = row.semantic_analysis;
  if (row.params?.provenance != null) asset.provenance = row.params.provenance;
  if (Array.isArray(row.inputs) && row.inputs.length > 0) {
    asset.graphInputs = row.inputs;
  }
  if (row.content_hash != null) asset.contentHash = row.content_hash;
  if (row.inputs_fingerprint != null) {
    asset.inputsFingerprint = row.inputs_fingerprint;
  }
  if (row.visibility != null) asset.visibility = row.visibility;
  return asset;
}

async function mapAsset(row: AssetRow): Promise<V1Asset> {
  const asset = mapAssetRow(row);
  const resolvedUrl = await resolveAssetUrl(row);
  if (resolvedUrl) asset.remoteUrl = resolvedUrl;
  return asset;
}

async function mapAssets(rows: AssetRow[]): Promise<V1Asset[]> {
  return Promise.all(rows.map(mapAsset));
}

async function getAssetRow(
  db: SupabaseClient,
  workspaceId: string,
  projectId: string,
  assetId: string,
  context: string
): Promise<AssetRow> {
  const { data, error } = await db
    .from("assets")
    .select("*")
    .eq("id", assetId)
    .eq("project_id", projectId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (isNoRows(error)) throw notFound(`Asset not found: ${assetId}`);
  throwOnError(error, context);
  if (!data) throw notFound(`Asset not found: ${assetId}`);
  return data as AssetRow;
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------
export interface PageResult<T> {
  items: T[];
  nextCursor: string | null;
}

// Newest-first cursor pagination keyed on stable record IDs. We over-fetch by one
// to learn whether more rows exist, then trim. The (created_at desc, id desc)
// ordering matches the old JSON sort exactly; the cursor is the last item's id and
// its created_at locates the seek position even when timestamps collide.
function orderTuple(a: { id: string; createdAt: string }, b: { id: string; createdAt: string }): number {
  if (a.createdAt === b.createdAt) return a.id < b.id ? 1 : -1;
  return a.createdAt < b.createdAt ? 1 : -1;
}

function paginate<T extends { id: string; createdAt: string }>(
  all: T[],
  limit: number,
  cursor: string | null
): PageResult<T> {
  const sorted = [...all].sort(orderTuple);
  let start = 0;
  if (cursor) {
    const idx = sorted.findIndex((item) => item.id === cursor);
    start = idx === -1 ? sorted.length : idx + 1;
  }
  const items = sorted.slice(start, start + limit);
  const nextCursor =
    start + limit < sorted.length && items.length > 0
      ? items[items.length - 1].id
      : null;
  return { items, nextCursor };
}

function updatedOrderTuple(
  a: { id: string; updatedAt: string },
  b: { id: string; updatedAt: string }
): number {
  if (a.updatedAt === b.updatedAt) return a.id < b.id ? 1 : -1;
  return a.updatedAt < b.updatedAt ? 1 : -1;
}

function paginateByUpdatedAt<T extends { id: string; updatedAt: string }>(
  all: T[],
  limit: number,
  cursor: string | null
): PageResult<T> {
  const sorted = [...all].sort(updatedOrderTuple);
  let start = 0;
  if (cursor) {
    const idx = sorted.findIndex((item) => item.id === cursor);
    start = idx === -1 ? sorted.length : idx + 1;
  }
  const items = sorted.slice(start, start + limit);
  const nextCursor =
    start + limit < sorted.length && items.length > 0
      ? items[items.length - 1].id
      : null;
  return { items, nextCursor };
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------
// Find-or-create a workspace by a stable NATURAL KEY (not an app-minted id).
// Workspace ids are DB-generated (gen_random_uuid); identity singletons are
// resolved by querying the natural key and inserting (omitting `id`) only when
// absent. Two natural keys are supported, backed by partial unique indexes:
//   * the local dev workspace: owner_id IS NULL, matched by name.
//   * a per-user workspace: matched by owner_id (one workspace per domain user).
async function ensureWorkspaceByNaturalKey(
  match: { ownerId: string } | { localName: string },
  name: string
): Promise<V1Workspace> {
  const db = getServiceSupabase();
  const query = db.from("workspaces").select("*");
  const scoped =
    "ownerId" in match
      ? query.eq("owner_id", match.ownerId)
      : query.is("owner_id", null).eq("name", match.localName);
  const existing = await scoped.maybeSingle();
  throwOnError(existing.error, "ensureWorkspace select");
  if (existing.data) return mapWorkspace(existing.data as WorkspaceRow);

  const now = new Date().toISOString();
  const inserted = await db
    .from("workspaces")
    .insert({
      schema_version: SCHEMA_VERSIONS.workspace,
      owner_id: "ownerId" in match ? match.ownerId : null,
      name,
      created_at: now,
      updated_at: now,
    })
    .select("*")
    .single();

  // Tolerate the race where a concurrent caller inserted first: the natural-key
  // unique index rejects the duplicate, so re-read and return the winner.
  if (inserted.error) {
    const rereadQuery = db.from("workspaces").select("*");
    const rescoped =
      "ownerId" in match
        ? rereadQuery.eq("owner_id", match.ownerId)
        : rereadQuery.is("owner_id", null).eq("name", match.localName);
    const reread = await rescoped.maybeSingle();
    throwOnError(reread.error, "ensureWorkspace reread");
    if (reread.data) return mapWorkspace(reread.data as WorkspaceRow);
    throwOnError(inserted.error, "ensureWorkspace insert");
  }
  return mapWorkspace(inserted.data as WorkspaceRow);
}

// The single unowned local dev workspace, matched by name.
export function ensureLocalWorkspace(name: string): Promise<V1Workspace> {
  return ensureWorkspaceByNaturalKey({ localName: name }, name);
}

// The workspace owned by a given domain user (public.users.id), one per user.
export function ensureUserWorkspace(
  ownerId: string,
  name: string
): Promise<V1Workspace> {
  return ensureWorkspaceByNaturalKey({ ownerId }, name);
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------
export async function createProject(input: {
  workspaceId: string;
  name: string;
  brief?: VideoBrief;
}): Promise<{ project: V1Project; briefVersion: V1BriefVersion | null }> {
  const db = getServiceSupabase();
  const now = new Date().toISOString();
  const visibility = await defaultVisibilityForWorkspace(db, input.workspaceId);

  const insertedProject = await db
    .from("projects")
    .insert({
      schema_version: SCHEMA_VERSIONS.project,
      workspace_id: input.workspaceId,
      name: input.name,
      status: "active",
      visibility,
      created_at: now,
      updated_at: now,
    })
    .select("*")
    .single();
  throwOnError(insertedProject.error, "createProject insert project");
  const projectRow = insertedProject.data as ProjectRow;
  const projectId = projectRow.id;

  let briefVersion: V1BriefVersion | null = null;
  if (input.brief) {
    const action = await createAction({
      projectId,
      tool: "create_brief",
      status: "running",
      params: { source: "createProject" },
      rationale: "Create the initial project brief asset.",
    });
    const briefAsset = await insertDataAsset({
      db,
      workspaceId: input.workspaceId,
      projectId,
      kind: "brief",
      role: "current_brief",
      content: input.brief,
      createdByActionId: action.id,
    });
    await setActiveAssetSelection(db, projectId, "brief", briefAsset.id, action.id);
    await updateAction(action.id, {
      status: "applied",
      outputAssetIds: [briefAsset.id],
    });
    briefVersion = mapBriefVersion(briefAsset);
  }

  return { project: await mapProjectWithProjection(db, projectRow), briefVersion };
}

// Attach a brief to an EXISTING project: persists a brief data-asset and points
// the project's active 'brief' selection at it, wrapped in a create_brief action
// for provenance. This is the same persistence the createProject brief-block
// runs; it is factored out so the orchestrator create_or_load_brief tool can
// write a brief into a project it did not create.
export async function addProjectBrief(input: {
  workspaceId: string;
  projectId: string;
  brief: VideoBrief;
}): Promise<V1BriefVersion> {
  const db = getServiceSupabase();
  const action = await createAction({
    projectId: input.projectId,
    tool: "create_brief",
    status: "running",
    params: { source: "create_or_load_brief" },
    rationale: "Create the project brief asset via the orchestrator tool.",
  });
  const briefAsset = await insertDataAsset({
    db,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    kind: "brief",
    role: "current_brief",
    content: input.brief,
    createdByActionId: action.id,
  });
  await setActiveAssetSelection(db, input.projectId, "brief", briefAsset.id, action.id);
  await updateAction(action.id, {
    status: "applied",
    outputAssetIds: [briefAsset.id],
  });
  return mapBriefVersion(briefAsset);
}

export async function getProject(
  workspaceId: string,
  projectId: string
): Promise<V1Project> {
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .eq("workspace_id", workspaceId)
    .neq("status", "deleted")
    .maybeSingle();
  if (isNoRows(error)) throw notFound(`Project not found: ${projectId}`);
  throwOnError(error, "getProject");
  if (!data) throw notFound(`Project not found: ${projectId}`);
  return mapProjectWithProjection(db, data as ProjectRow);
}

// Point the project-scoped 'poster' selection slot at an image asset. Any
// ready image in the project qualifies (a keyframe can be the poster until a
// dedicated poster-kind asset is generated); history stays in selections.
export async function setProjectPoster(
  workspaceId: string,
  projectId: string,
  assetId: string
): Promise<V1Project> {
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .eq("workspace_id", workspaceId)
    .neq("status", "deleted")
    .maybeSingle();
  if (isNoRows(error)) throw notFound(`Project not found: ${projectId}`);
  throwOnError(error, "setProjectPoster project");
  if (!data) throw notFound(`Project not found: ${projectId}`);
  const projectRow = data as ProjectRow;

  const asset = await readyImageAssetById(db, projectId, assetId);
  if (!asset) {
    throw new ApiError(
      "validation_failed",
      `Asset ${assetId} is not a ready image asset in project ${projectId}.`
    );
  }

  const action = await createAction({
    projectId,
    tool: "set_poster",
    status: "applied",
    params: { assetId },
    inputAssetIds: [assetId],
    rationale: "Set the project poster (dashboard thumbnail).",
  });
  await setActiveAssetSelection(db, projectId, POSTER_SLOT_ROLE, assetId, action.id);
  return mapProjectWithProjection(db, projectRow);
}

interface StoryboardRow {
  id: string;
  project_id: string;
  plan_asset_id: string | null;
  status: StoryboardStatus;
  created_at: string;
  updated_at: string;
}

interface StoryboardSceneRow {
  id: string;
  project_id: string;
  storyboard_id: string;
  scene_index: number;
  title: string | null;
  summary: string | null;
  setting: string | null;
  mood: string | null;
  duration_sec: number | null;
  scene_asset_id: string | null;
  status: StoryboardItemStatus;
  created_at: string;
  updated_at: string;
}

interface StoryboardBeatRow {
  id: string;
  project_id: string;
  scene_id: string;
  beat_index: number;
  intent: string;
  visual_description: string | null;
  dialogue_summary: string | null;
  narration: string | null;
  duration_sec: number | null;
  status: StoryboardItemStatus;
  beat_asset_id: string | null;
  created_at: string;
  updated_at: string;
}

interface StoryboardPanelRow {
  id: string;
  project_id: string;
  beat_id: string;
  panel_index: number;
  image_asset_id: string | null;
  prompt_asset_id: string | null;
  status: StoryboardItemStatus;
  is_selected: boolean;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SaveStoryboardSceneInput {
  id: string;
  title: string | null;
  summary?: string | null;
  setting?: string | null;
  mood?: string | null;
  durationSec?: number | null;
  status?: StoryboardItemStatus;
  beats: SaveStoryboardBeatInput[];
}

export interface SaveStoryboardBeatInput {
  id: string;
  intent: string;
  visualDescription?: string | null;
  dialogueSummary?: string | null;
  narration?: string | null;
  durationSec?: number | null;
  status?: StoryboardItemStatus;
}

export interface SaveStoryboardInput {
  id?: string | null;
  status?: StoryboardStatus;
  scenes: SaveStoryboardSceneInput[];
}

function mapStoryboardPanel(row: StoryboardPanelRow): StoryboardPanel {
  return {
    id: row.id,
    projectId: row.project_id,
    beatId: row.beat_id,
    panelIndex: row.panel_index,
    imageAssetId: row.image_asset_id,
    promptAssetId: row.prompt_asset_id,
    status: row.status,
    isSelected: row.is_selected,
    approvedAt: row.approved_at ? iso(row.approved_at) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapStoryboardBeat(
  row: StoryboardBeatRow,
  panels: StoryboardPanel[]
): StoryboardBeat {
  return {
    id: row.id,
    projectId: row.project_id,
    sceneId: row.scene_id,
    beatIndex: row.beat_index,
    intent: row.intent,
    visualDescription: row.visual_description,
    dialogueSummary: row.dialogue_summary,
    narration: row.narration,
    durationSec: row.duration_sec,
    status: row.status,
    beatAssetId: row.beat_asset_id,
    panels,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapStoryboardScene(
  row: StoryboardSceneRow,
  beats: StoryboardBeat[]
): StoryboardScene {
  return {
    id: row.id,
    projectId: row.project_id,
    storyboardId: row.storyboard_id,
    sceneIndex: row.scene_index,
    title: row.title,
    summary: row.summary,
    setting: row.setting,
    mood: row.mood,
    durationSec: row.duration_sec,
    sceneAssetId: row.scene_asset_id,
    status: row.status,
    beats,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapStoryboard(
  row: StoryboardRow,
  scenes: StoryboardScene[]
): ProjectStoryboard {
  return {
    id: row.id,
    projectId: row.project_id,
    planAssetId: row.plan_asset_id,
    status: row.status,
    scenes,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

async function getStoryboardRow(
  db: SupabaseClient,
  projectId: string,
  storyboardId?: string | null
): Promise<StoryboardRow | null> {
  let query = db
    .from("storyboards")
    .select("*")
    .eq("project_id", projectId);
  if (storyboardId) query = query.eq("id", storyboardId);
  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (isNoRows(error)) return null;
  throwOnError(error, "getStoryboardRow");
  return (data as StoryboardRow | null) ?? null;
}

async function requireProjectRow(
  db: SupabaseClient,
  workspaceId: string,
  projectId: string
): Promise<ProjectRow> {
  const { data, error } = await db
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .eq("workspace_id", workspaceId)
    .neq("status", "deleted")
    .maybeSingle();
  if (isNoRows(error)) throw notFound(`Project not found: ${projectId}`);
  throwOnError(error, "requireProjectRow");
  if (!data) throw notFound(`Project not found: ${projectId}`);
  return data as ProjectRow;
}

export async function getProjectStoryboard(
  workspaceId: string,
  projectId: string
): Promise<ProjectStoryboard | null> {
  const db = getServiceSupabase();
  await requireProjectRow(db, workspaceId, projectId);
  const storyboard = await getStoryboardRow(db, projectId);
  if (!storyboard) return null;

  const scenesResult = await db
    .from("storyboard_scenes")
    .select("*")
    .eq("project_id", projectId)
    .eq("storyboard_id", storyboard.id)
    .order("scene_index", { ascending: true });
  throwOnError(scenesResult.error, "getProjectStoryboard scenes");
  const sceneRows = (scenesResult.data ?? []) as StoryboardSceneRow[];
  const sceneIds = sceneRows.map((scene) => scene.id);

  const beatsResult = sceneIds.length
    ? await db
        .from("storyboard_beats")
        .select("*")
        .eq("project_id", projectId)
        .in("scene_id", sceneIds)
        .order("beat_index", { ascending: true })
    : { data: [], error: null };
  throwOnError(beatsResult.error, "getProjectStoryboard beats");
  const beatRows = (beatsResult.data ?? []) as StoryboardBeatRow[];
  const beatIds = beatRows.map((beat) => beat.id);

  const panelsResult = beatIds.length
    ? await db
        .from("storyboard_panels")
        .select("*")
        .eq("project_id", projectId)
        .in("beat_id", beatIds)
        .order("panel_index", { ascending: true })
    : { data: [], error: null };
  throwOnError(panelsResult.error, "getProjectStoryboard panels");
  const panelRows = (panelsResult.data ?? []) as StoryboardPanelRow[];

  const panelsByBeat = new Map<string, StoryboardPanel[]>();
  for (const panel of panelRows.map(mapStoryboardPanel)) {
    panelsByBeat.set(panel.beatId, [...(panelsByBeat.get(panel.beatId) ?? []), panel]);
  }

  const beatsByScene = new Map<string, StoryboardBeat[]>();
  for (const beatRow of beatRows) {
    const beat = mapStoryboardBeat(beatRow, panelsByBeat.get(beatRow.id) ?? []);
    beatsByScene.set(beat.sceneId, [...(beatsByScene.get(beat.sceneId) ?? []), beat]);
  }

  return mapStoryboard(
    storyboard,
    sceneRows.map((scene) => mapStoryboardScene(scene, beatsByScene.get(scene.id) ?? []))
  );
}

function semanticBeatChanged(
  before: StoryboardBeatRow,
  after: SaveStoryboardBeatInput
): boolean {
  return (
    before.intent !== after.intent ||
    before.visual_description !== (after.visualDescription ?? null) ||
    before.dialogue_summary !== (after.dialogueSummary ?? null) ||
    before.narration !== (after.narration ?? null) ||
    before.duration_sec !== (after.durationSec ?? null)
  );
}

async function nextBeatSnapshotAssetId(input: {
  db: SupabaseClient;
  workspaceId: string;
  projectId: string;
  existing: StoryboardBeatRow | undefined;
  beat: SaveStoryboardBeatInput;
}): Promise<string | null> {
  if (!input.existing?.beat_asset_id) return input.existing?.beat_asset_id ?? null;
  if (!semanticBeatChanged(input.existing, input.beat)) return input.existing.beat_asset_id;

  const previous = await dataAssetById(input.db, input.existing.beat_asset_id);
  const asset = await insertDataAsset({
    db: input.db,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    kind: "beat",
    role: "beat_snapshot",
    content: {
      intent: input.beat.intent,
      visual_description: input.beat.visualDescription ?? null,
      dialogue_summary: input.beat.dialogueSummary ?? null,
      narration: input.beat.narration ?? null,
      duration_sec: input.beat.durationSec ?? null,
    },
    lineageId: previous?.lineage_id,
    version: previous ? previous.version + 1 : undefined,
  });
  return asset.id;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertUuid(value: string | null | undefined, path: string): void {
  if (value && !UUID_RE.test(value)) {
    throw new ApiError("validation_failed", `${path} must be a UUID.`);
  }
}

async function assertStoryboardIdAvailable(
  db: SupabaseClient,
  projectId: string,
  storyboardId: string | null | undefined
): Promise<void> {
  assertUuid(storyboardId, "id");
  if (!storyboardId) return;
  const { data, error } = await db
    .from("storyboards")
    .select("id, project_id")
    .eq("id", storyboardId)
    .maybeSingle();
  if (isNoRows(error)) return;
  throwOnError(error, "assertStoryboardIdAvailable");
  if (data && (data as StoryboardRow).project_id !== projectId) {
    throw new ApiError("validation_failed", "Storyboard id belongs to another project.");
  }
}

async function assertStoryboardRowsAreWritable(input: {
  db: SupabaseClient;
  projectId: string;
  storyboardId: string;
  storyboard: SaveStoryboardInput;
}): Promise<void> {
  const sceneIds = input.storyboard.scenes.map((scene) => scene.id);
  const beatIds = input.storyboard.scenes.flatMap((scene) =>
    scene.beats.map((beat) => beat.id)
  );
  for (const [index, scene] of input.storyboard.scenes.entries()) {
    assertUuid(scene.id, `scenes[${index}].id`);
    for (const [beatIndex, beat] of scene.beats.entries()) {
      assertUuid(beat.id, `scenes[${index}].beats[${beatIndex}].id`);
    }
  }

  if (sceneIds.length > 0) {
    const { data, error } = await input.db
      .from("storyboard_scenes")
      .select("id, project_id, storyboard_id")
      .in("id", sceneIds);
    throwOnError(error, "assertStoryboardRowsAreWritable scenes");
    for (const row of (data ?? []) as StoryboardSceneRow[]) {
      if (row.project_id !== input.projectId || row.storyboard_id !== input.storyboardId) {
        throw new ApiError(
          "validation_failed",
          `Scene id belongs to another storyboard: ${row.id}.`
        );
      }
    }
  }

  if (beatIds.length === 0) return;
  const beats = await input.db
    .from("storyboard_beats")
    .select("id, project_id, scene_id")
    .in("id", beatIds);
  throwOnError(beats.error, "assertStoryboardRowsAreWritable beats");
  const existingBeatRows = (beats.data ?? []) as Pick<
    StoryboardBeatRow,
    "id" | "project_id" | "scene_id"
  >[];
  const existingBeatSceneIds = [
    ...new Set(existingBeatRows.map((beat) => beat.scene_id)),
  ];
  const beatScenes = existingBeatSceneIds.length
    ? await input.db
        .from("storyboard_scenes")
        .select("id, project_id, storyboard_id")
        .in("id", existingBeatSceneIds)
    : { data: [], error: null };
  throwOnError(beatScenes.error, "assertStoryboardRowsAreWritable beat scenes");
  const sceneById = new Map(
    ((beatScenes.data ?? []) as StoryboardSceneRow[]).map((scene) => [scene.id, scene])
  );
  for (const row of existingBeatRows) {
    const scene = sceneById.get(row.scene_id);
    if (
      row.project_id !== input.projectId ||
      !scene ||
      scene.project_id !== input.projectId ||
      scene.storyboard_id !== input.storyboardId
    ) {
      throw new ApiError(
        "validation_failed",
        `Beat id belongs to another storyboard: ${row.id}.`
      );
    }
  }
}

async function restoreStoryboardOrder(
  db: SupabaseClient,
  projectId: string,
  scenes: Array<{ id: string; sceneIndex: number }>,
  beats: Array<{ id: string; beatIndex: number }>
): Promise<void> {
  for (const scene of scenes) {
    const { error } = await db
      .from("storyboard_scenes")
      .update({ scene_index: scene.sceneIndex })
      .eq("project_id", projectId)
      .eq("id", scene.id);
    throwOnError(error, "restoreStoryboardOrder scene");
  }
  for (const beat of beats) {
    const { error } = await db
      .from("storyboard_beats")
      .update({ beat_index: beat.beatIndex })
      .eq("project_id", projectId)
      .eq("id", beat.id);
    throwOnError(error, "restoreStoryboardOrder beat");
  }
}

export async function saveProjectStoryboard(
  workspaceId: string,
  projectId: string,
  input: SaveStoryboardInput
): Promise<ProjectStoryboard> {
  const db = getServiceSupabase();
  await requireProjectRow(db, workspaceId, projectId);
  const now = new Date().toISOString();
  await assertStoryboardIdAvailable(db, projectId, input.id);
  let storyboard = await getStoryboardRow(db, projectId, input.id);
  const storyboardId = storyboard?.id ?? input.id ?? randomUUID();
  await assertStoryboardRowsAreWritable({
    db,
    projectId,
    storyboardId,
    storyboard: input,
  });
  if (!storyboard) {
    const { data, error } = await db
      .from("storyboards")
      .insert({
        id: storyboardId,
        project_id: projectId,
        status: input.status ?? "draft",
        created_at: now,
        updated_at: now,
      })
      .select("*")
      .single();
    throwOnError(error, "saveProjectStoryboard create storyboard");
    storyboard = data as StoryboardRow;
  }

  const current = await getProjectStoryboard(workspaceId, projectId);
  const existingScenes = new Map(
    (current?.scenes ?? []).map((scene) => [scene.id, scene])
  );
  const existingBeats = new Map<string, StoryboardBeatRow>();
  for (const scene of current?.scenes ?? []) {
    for (const beat of scene.beats) {
      existingBeats.set(beat.id, {
        id: beat.id,
        project_id: beat.projectId,
        scene_id: beat.sceneId,
        beat_index: beat.beatIndex,
        intent: beat.intent,
        visual_description: beat.visualDescription,
        dialogue_summary: beat.dialogueSummary,
        narration: beat.narration,
        duration_sec: beat.durationSec,
        status: beat.status,
        beat_asset_id: beat.beatAssetId,
        created_at: beat.createdAt,
        updated_at: beat.updatedAt,
      });
    }
  }

  const sceneRows = input.scenes.map((scene, index) => ({
    id: scene.id,
    project_id: projectId,
    storyboard_id: storyboardId,
    scene_index: index,
    title: scene.title,
    summary: scene.summary ?? null,
    setting: scene.setting ?? null,
    mood: scene.mood ?? null,
    duration_sec: scene.durationSec ?? null,
    status: scene.status ?? "draft",
    updated_at: now,
  }));
  const beatRowsByScene = new Map<string, Record<string, unknown>[]>();
  for (const scene of input.scenes) {
    const beatRows = [];
    for (const [index, beat] of scene.beats.entries()) {
      const existing = existingBeats.get(beat.id);
      beatRows.push({
        id: beat.id,
        project_id: projectId,
        scene_id: scene.id,
        beat_index: index,
        intent: beat.intent,
        visual_description: beat.visualDescription ?? null,
        dialogue_summary: beat.dialogueSummary ?? null,
        narration: beat.narration ?? null,
        duration_sec: beat.durationSec ?? null,
        status: beat.status ?? "draft",
        beat_asset_id: await nextBeatSnapshotAssetId({
          db,
          workspaceId,
          projectId,
          existing,
          beat,
        }),
        updated_at: now,
      });
    }
    beatRowsByScene.set(scene.id, beatRows);
  }

  const sceneOrderBackup = (current?.scenes ?? []).map((scene) => ({
    id: scene.id,
    sceneIndex: scene.sceneIndex,
  }));
  const beatOrderBackup = (current?.scenes ?? []).flatMap((scene) =>
    scene.beats.map((beat) => ({ id: beat.id, beatIndex: beat.beatIndex }))
  );

  try {
    const keepSceneIds = new Set(input.scenes.map((scene) => scene.id));
    const keepBeatIds = new Set(
      input.scenes.flatMap((scene) => scene.beats.map((beat) => beat.id))
    );
    const removeSceneIds = [...existingScenes.keys()].filter((id) => !keepSceneIds.has(id));
    const removeBeatIds = [...existingBeats.keys()].filter((id) => !keepBeatIds.has(id));

    const existingSceneIds = [...existingScenes.keys()];
    if (existingSceneIds.length > 0) {
      const updates = existingSceneIds.map((id, index) =>
        db
          .from("storyboard_scenes")
          .update({ scene_index: 10000 + index })
          .eq("project_id", projectId)
          .eq("id", id)
      );
      for (const update of updates) throwOnError((await update).error, "saveProjectStoryboard offset scenes");
    }

    for (const sceneRow of sceneRows) {
      if (existingScenes.has(sceneRow.id)) {
        const { error } = await db
          .from("storyboard_scenes")
          .update(sceneRow)
          .eq("project_id", projectId)
          .eq("id", sceneRow.id);
        throwOnError(error, "saveProjectStoryboard update scene");
      } else {
        const { error } = await db.from("storyboard_scenes").insert(sceneRow);
        throwOnError(error, "saveProjectStoryboard insert scene");
      }
    }

    const existingBeatIds = [...existingBeats.keys()];
    for (const [index, id] of existingBeatIds.entries()) {
      const { error } = await db
        .from("storyboard_beats")
        .update({ beat_index: 10000 + index })
        .eq("project_id", projectId)
        .eq("id", id);
      throwOnError(error, "saveProjectStoryboard offset beats");
    }

    for (const scene of input.scenes) {
      for (const beatRow of beatRowsByScene.get(scene.id) ?? []) {
        const id = String(beatRow.id);
        if (existingBeats.has(id)) {
          const { error } = await db
            .from("storyboard_beats")
            .update(beatRow)
            .eq("project_id", projectId)
            .eq("id", id);
          throwOnError(error, "saveProjectStoryboard update beat");
        } else {
          const { error } = await db.from("storyboard_beats").insert(beatRow);
          throwOnError(error, "saveProjectStoryboard insert beat");
        }
      }
    }

    if (removeBeatIds.length > 0) {
      const { error } = await db
        .from("storyboard_beats")
        .delete()
        .eq("project_id", projectId)
        .in("id", removeBeatIds);
      throwOnError(error, "saveProjectStoryboard remove beats");
    }
    if (removeSceneIds.length > 0) {
      const { error } = await db
        .from("storyboard_scenes")
        .delete()
        .eq("project_id", projectId)
        .in("id", removeSceneIds);
      throwOnError(error, "saveProjectStoryboard remove scenes");
    }

    const { error } = await db
      .from("storyboards")
      .update({ status: input.status ?? storyboard.status, updated_at: now })
      .eq("project_id", projectId)
      .eq("id", storyboard.id);
    throwOnError(error, "saveProjectStoryboard update storyboard");
  } catch (err) {
    await restoreStoryboardOrder(db, projectId, sceneOrderBackup, beatOrderBackup);
    throw err;
  }

  const saved = await getProjectStoryboard(workspaceId, projectId);
  if (!saved) throw notFound(`Storyboard not found: ${storyboard.id}`);
  return saved;
}

export async function listProjects(
  workspaceId: string,
  limit: number,
  cursor: string | null
): Promise<PageResult<V1Project>> {
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("projects")
    .select("*")
    .eq("workspace_id", workspaceId)
    .neq("status", "deleted");
  throwOnError(error, "listProjects");
  const all = await Promise.all(
    (data as ProjectRow[]).map((row) => mapProjectWithProjection(db, row))
  );
  return paginate(all, limit, cursor);
}

export async function listPublicProjects(
  limit: number,
  cursor: string | null
): Promise<PageResult<V1Project>> {
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("projects")
    .select("*")
    .eq("visibility", "public")
    .neq("status", "deleted");
  throwOnError(error, "listPublicProjects");
  const all = await Promise.all(
    (data as ProjectRow[]).map((row) =>
      mapProjectWithProjection(db, row, { publicOnly: true })
    )
  );
  return paginate(all, limit, cursor);
}

export async function setBrief(
  workspaceId: string,
  projectId: string,
  brief: VideoBrief
): Promise<V1Project> {
  const db = getServiceSupabase();
  const { project } = await createBriefVersion(workspaceId, projectId, brief);
  return project;
}

export async function createBriefVersion(
  workspaceId: string,
  projectId: string,
  brief: VideoBrief
): Promise<{ project: V1Project; briefVersion: V1BriefVersion }> {
  // Confirm the project exists within the workspace before writing the version.
  const db = getServiceSupabase();
  await getProject(workspaceId, projectId);
  const previous = await selectedDataAsset(db, projectId, "brief", "brief");
  const action = await createAction({
    projectId,
    tool: previous ? "update_brief" : "create_brief",
    status: "running",
    params: { source: "createBriefVersion" },
    inputAssetIds: previous ? [previous.id] : [],
    rationale: previous
      ? "Create a new immutable brief asset version."
      : "Create the initial brief asset.",
  });
  const briefAsset = await insertDataAsset({
    db,
    workspaceId,
    projectId,
    kind: "brief",
    role: "current_brief",
    content: brief,
    lineageId: previous?.lineage_id,
    version: previous ? previous.version + 1 : undefined,
    createdByActionId: action.id,
  });
  await setActiveAssetSelection(db, projectId, "brief", briefAsset.id, action.id);
  await updateAction(action.id, {
    status: "applied",
    outputAssetIds: [briefAsset.id],
  });
  return {
    project: await getProject(workspaceId, projectId),
    briefVersion: mapBriefVersion(briefAsset),
  };
}

export async function listBriefVersions(
  workspaceId: string,
  projectId: string,
  limit: number,
  cursor: string | null
): Promise<PageResult<V1BriefVersion>> {
  await getProject(workspaceId, projectId);
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("assets")
    .select("*")
    .eq("project_id", projectId)
    .eq("kind", "brief")
    .eq("media", "data");
  throwOnError(error, "listBriefVersions");
  const all = (data as DataAssetRow[]).map(mapBriefVersion);
  return paginate(all, limit, cursor);
}

// ---------------------------------------------------------------------------
// Studio drafts
// ---------------------------------------------------------------------------
export async function listStudioDrafts(
  workspaceId: string,
  actor: { id: string; isLocal: boolean },
  limit: number,
  cursor: string | null
): Promise<PageResult<StudioDraftSummary>> {
  const db = getServiceSupabase();
  let query = db
    .from("studio_drafts")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("updated_at", { ascending: false })
    .order("id", { ascending: false });
  query = actor.isLocal
    ? query.eq("local_actor_id", actor.id).is("owner_user_id", null)
    : query.eq("owner_user_id", actor.id);

  const { data, error } = await query;
  throwOnError(error, "listStudioDrafts");
  const all = (data as StudioDraftRow[]).map(mapStudioDraftSummary);
  return paginateByUpdatedAt(all, limit, cursor);
}

export async function createStudioDraft(input: {
  workspaceId: string;
  actor: { id: string; isLocal: boolean };
  payload: StudioDraftPayload;
}): Promise<StudioDraft> {
  await assertStudioDraftRefs(input.workspaceId, input.payload);
  const db = getServiceSupabase();
  const now = new Date().toISOString();
  const row = {
    schema_version: STUDIO_DRAFT_SCHEMA_VERSION,
    workspace_id: input.workspaceId,
    owner_user_id: input.actor.isLocal ? null : input.actor.id,
    local_actor_id: input.actor.isLocal ? input.actor.id : null,
    payload: input.payload,
    display_excerpt: displayExcerptForStudioDraft(input.payload),
    step: input.payload.step,
    project_id: input.payload.projectId ?? null,
    run_id: input.payload.runId ?? null,
    created_at: now,
    updated_at: now,
  };

  const { data, error } = await db
    .from("studio_drafts")
    .insert(row)
    .select("*")
    .single();
  throwOnError(error, "createStudioDraft");
  return mapStudioDraft(data as StudioDraftRow);
}

export async function getStudioDraft(
  workspaceId: string,
  actor: { id: string; isLocal: boolean },
  draftId: string
): Promise<StudioDraft> {
  const db = getServiceSupabase();
  let query = db
    .from("studio_drafts")
    .select("*")
    .eq("id", draftId)
    .eq("workspace_id", workspaceId);
  query = actor.isLocal
    ? query.eq("local_actor_id", actor.id).is("owner_user_id", null)
    : query.eq("owner_user_id", actor.id);

  const { data, error } = await query.maybeSingle();
  if (isNoRows(error)) throw notFound(`Studio draft not found: ${draftId}`);
  throwOnError(error, "getStudioDraft");
  if (!data) throw notFound(`Studio draft not found: ${draftId}`);
  return mapStudioDraft(data as StudioDraftRow);
}

export async function updateStudioDraft(input: {
  workspaceId: string;
  actor: { id: string; isLocal: boolean };
  draftId: string;
  payload: StudioDraftPayload;
}): Promise<StudioDraft> {
  await assertStudioDraftRefs(input.workspaceId, input.payload);
  const db = getServiceSupabase();
  const patch = {
    payload: input.payload,
    display_excerpt: displayExcerptForStudioDraft(input.payload),
    step: input.payload.step,
    project_id: input.payload.projectId ?? null,
    run_id: input.payload.runId ?? null,
    updated_at: new Date().toISOString(),
  };

  let query = db
    .from("studio_drafts")
    .update(patch)
    .eq("id", input.draftId)
    .eq("workspace_id", input.workspaceId);
  query = input.actor.isLocal
    ? query.eq("local_actor_id", input.actor.id).is("owner_user_id", null)
    : query.eq("owner_user_id", input.actor.id);

  const { data, error } = await query.select("*").maybeSingle();
  if (isNoRows(error)) throw notFound(`Studio draft not found: ${input.draftId}`);
  throwOnError(error, "updateStudioDraft");
  if (!data) throw notFound(`Studio draft not found: ${input.draftId}`);
  return mapStudioDraft(data as StudioDraftRow);
}

export async function deleteStudioDraft(
  workspaceId: string,
  actor: { id: string; isLocal: boolean },
  draftId: string
): Promise<void> {
  const db = getServiceSupabase();
  let query = db
    .from("studio_drafts")
    .delete()
    .eq("id", draftId)
    .eq("workspace_id", workspaceId);
  query = actor.isLocal
    ? query.eq("local_actor_id", actor.id).is("owner_user_id", null)
    : query.eq("owner_user_id", actor.id);

  const { data, error } = await query.select("id").maybeSingle();
  if (isNoRows(error)) throw notFound(`Studio draft not found: ${draftId}`);
  throwOnError(error, "deleteStudioDraft");
  if (!data) throw notFound(`Studio draft not found: ${draftId}`);
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------
export async function addAsset(
  asset: V1Asset,
  options: { createdByActionId?: string } = {}
): Promise<V1Asset> {
  const db = getServiceSupabase();
  const assetWithGraph = await withGraphMetadataForInsert(db, asset);
  // Omit `id` so Postgres assigns it (gen_random_uuid); any id on the incoming
  // object is a placeholder and is read back from the inserted row.
  const { id: _omit, ...row } = assetToRow(assetWithGraph);
  void _omit;
  row.visibility = await defaultVisibilityForWorkspace(db, assetWithGraph.workspaceId);
  if (options.createdByActionId) {
    row.created_by_action_id = options.createdByActionId;
  }
  const { data, error } = await db
    .from("assets")
    .insert(row)
    .select("*")
    .single();
  throwOnError(error, "addAsset");
  return mapAsset(data as AssetRow);
}

export async function getAsset(
  workspaceId: string,
  projectId: string,
  assetId: string
): Promise<V1Asset> {
  const db = getServiceSupabase();
  return mapAsset(await getAssetRow(db, workspaceId, projectId, assetId, "getAsset"));
}

export async function updateAsset(
  workspaceId: string,
  projectId: string,
  assetId: string,
  updater: (asset: V1Asset) => void
): Promise<V1Asset> {
  // Read-modify-write: load the current row (with tenancy filter), apply the
  // mutation in memory, then persist the full row back.
  const db = getServiceSupabase();
  const current = mapAssetRow(
    await getAssetRow(db, workspaceId, projectId, assetId, "updateAsset read")
  );
  updater(current);
  current.updatedAt = new Date().toISOString();

  const row = assetToRow(current);
  const { data, error } = await db
    .from("assets")
    .update({
      status: row.status,
      filename: row.filename,
      remote_url: row.remote_url,
      storage_key: row.storage_key,
      storage_bucket: row.storage_bucket,
      duration_sec: row.duration_sec,
      description: row.description,
      context: row.context,
      semantic_analysis: row.semantic_analysis,
      updated_at: row.updated_at,
    })
    .eq("id", assetId)
    .eq("project_id", projectId)
    .eq("workspace_id", workspaceId)
    .select("*")
    .maybeSingle();
  if (isNoRows(error)) throw notFound(`Asset not found: ${assetId}`);
  throwOnError(error, "updateAsset");
  if (!data) throw notFound(`Asset not found: ${assetId}`);
  return mapAsset(data as AssetRow);
}

export async function setAssetVisibility(
  workspaceId: string,
  projectId: string,
  assetId: string,
  visibility: "public" | "private",
  options: { actorId?: string; store?: VisibilityObjectStore } = {}
): Promise<V1Asset> {
  const db = getServiceSupabase();

  const { data: projectData, error: projectError } = await db
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .eq("workspace_id", workspaceId)
    .neq("status", "deleted")
    .maybeSingle();
  if (isNoRows(projectError)) throw notFound(`Project not found: ${projectId}`);
  throwOnError(projectError, "setAssetVisibility project");
  if (!projectData) throw notFound(`Project not found: ${projectId}`);
  const project = projectData as ProjectRow;

  const { data: currentData, error: currentError } = await db
    .from("assets")
    .select("*")
    .eq("id", assetId)
    .eq("project_id", projectId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (isNoRows(currentError)) throw notFound(`Asset not found: ${assetId}`);
  throwOnError(currentError, "setAssetVisibility current");
  if (!currentData) throw notFound(`Asset not found: ${assetId}`);
  const current = currentData as AssetRow;

  const action = await createAction({
    projectId,
    tool: "set_asset_visibility",
    status: "running",
    params: {
      actorId: options.actorId,
      assetId,
      previousVisibility: current.visibility ?? "public",
      visibility,
      projectVisibility: project.visibility ?? "public",
    },
    inputAssetIds: [assetId],
    rationale: `Set asset visibility to ${visibility}.`,
  });

  let updated: AssetRow | null = null;
  try {
    await reconcileAssetStorage({
      asset: {
        id: assetId,
        storageKey: current.storage_key,
        storageBucket: current.storage_bucket,
        visibility,
      },
      projectVisibility: project.visibility ?? "public",
      previousEffectiveVisibility:
        (current.visibility ?? "public") === "public" &&
        (project.visibility ?? "public") === "public"
          ? "public"
          : "private",
      store: options.store,
      persistStorageBucket: async (storageBucket) => {
        const { data, error } = await db
          .from("assets")
          .update({
            visibility,
            storage_bucket: storageBucket,
            updated_at: new Date().toISOString(),
          })
          .eq("id", assetId)
          .eq("project_id", projectId)
          .eq("workspace_id", workspaceId)
          .select("*")
          .maybeSingle();
        if (isNoRows(error)) throw notFound(`Asset not found: ${assetId}`);
        throwOnError(error, "setAssetVisibility update");
        if (!data) throw notFound(`Asset not found: ${assetId}`);
        updated = data as AssetRow;
      },
    });
    await updateAction(action.id, {
      status: "applied",
      outputAssetIds: [assetId],
    });
  } catch (error) {
    await updateAction(action.id, {
      status: "failed",
      error: {
        message: error instanceof Error ? error.message : "Visibility update failed.",
      },
    });
    throw error;
  }

  if (!updated) throw new ApiError("internal_error", "Asset visibility update failed.");
  return mapAsset(updated);
}

export async function setProjectVisibility(
  workspaceId: string,
  projectId: string,
  visibility: "public" | "private",
  options: { actorId?: string; store?: VisibilityObjectStore } = {}
): Promise<V1Project> {
  const db = getServiceSupabase();

  const { data: projectData, error: projectError } = await db
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .eq("workspace_id", workspaceId)
    .neq("status", "deleted")
    .maybeSingle();
  if (isNoRows(projectError)) throw notFound(`Project not found: ${projectId}`);
  throwOnError(projectError, "setProjectVisibility project");
  if (!projectData) throw notFound(`Project not found: ${projectId}`);
  const project = projectData as ProjectRow;

  const { data: assetData, error: assetError } = await db
    .from("assets")
    .select("*")
    .eq("project_id", projectId)
    .eq("workspace_id", workspaceId)
    .neq("media", "data");
  throwOnError(assetError, "setProjectVisibility assets");
  const assets = (assetData ?? []) as AssetRow[];

  const action = await createAction({
    projectId,
    tool: "set_project_visibility",
    status: "running",
    params: {
      actorId: options.actorId,
      previousVisibility: project.visibility ?? "public",
      visibility,
      assetCount: assets.length,
    },
    inputAssetIds: assets.map((asset) => asset.id),
    rationale: `Set project visibility to ${visibility} and reconcile asset storage.`,
  });

  try {
    for (const asset of assets) {
      await reconcileAssetStorage({
        asset: {
          id: asset.id,
          storageKey: asset.storage_key,
          storageBucket: asset.storage_bucket,
          visibility: asset.visibility ?? "public",
        },
        projectVisibility: visibility,
        previousEffectiveVisibility:
          (asset.visibility ?? "public") === "public" &&
          (project.visibility ?? "public") === "public"
            ? "public"
            : "private",
        store: options.store,
        persistStorageBucket: async (storageBucket) => {
          const { error } = await db
            .from("assets")
            .update({
              storage_bucket: storageBucket,
              updated_at: new Date().toISOString(),
            })
            .eq("id", asset.id)
            .eq("project_id", projectId)
            .eq("workspace_id", workspaceId);
          throwOnError(error, "setProjectVisibility asset bucket");
        },
      });
    }

    const { data, error } = await db
      .from("projects")
      .update({ visibility, updated_at: new Date().toISOString() })
      .eq("id", projectId)
      .eq("workspace_id", workspaceId)
      .neq("status", "deleted")
      .select("*")
      .maybeSingle();
    if (isNoRows(error)) throw notFound(`Project not found: ${projectId}`);
    throwOnError(error, "setProjectVisibility update project");
    if (!data) throw notFound(`Project not found: ${projectId}`);

    await updateAction(action.id, {
      status: "applied",
      outputAssetIds: assets.map((asset) => asset.id),
    });
    return mapProjectWithProjection(db, data as ProjectRow);
  } catch (error) {
    await updateAction(action.id, {
      status: "failed",
      error: {
        message: error instanceof Error ? error.message : "Project visibility update failed.",
      },
    });
    throw error;
  }
}

export async function updateAssetAnalysis(
  workspaceId: string,
  projectId: string,
  assetId: string,
  patch: {
    context?: AssetContext;
    semanticAnalysis?: AssetSemanticAnalysis;
    analysis: V1AssetAnalysis;
  }
): Promise<V1Asset> {
  return updateAsset(workspaceId, projectId, assetId, (asset) => {
    asset.analysis = patch.analysis;
    if (patch.context) asset.context = patch.context;
    if (patch.semanticAnalysis) asset.semanticAnalysis = patch.semanticAnalysis;
  });
}

export async function listAssets(
  workspaceId: string,
  projectId: string,
  limit: number,
  cursor: string | null
): Promise<PageResult<V1Asset>> {
  await getProject(workspaceId, projectId);
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("assets")
    .select("*")
    .eq("project_id", projectId)
    .eq("workspace_id", workspaceId)
    .neq("media", "data");
  throwOnError(error, "listAssets");
  const all = await mapAssets(data as AssetRow[]);
  return paginate(all, limit, cursor);
}

interface AssetWithProjectRow extends AssetRow {
  projects?: { id: string; visibility: "public" | "private"; status: "active" | "deleted" };
}

// Workspace-scoped asset summary for the cross-project dashboard list.
export interface WorkspaceAssetSummary {
  id: string;
  assetId: string;
  projectId: string;
  projectName: string;
  kind: AssetKind;
  status: "ready" | "pending";
  source: string;
  filename?: string;
  description?: string;
  url?: string;
  thumbnailUrl?: string;
  durationSec?: number;
  visibility: "public" | "private";
  createdAt: string;
  updatedAt: string;
}

export interface AssetMediaUrls {
  url: string | null;
  thumbnailUrl?: string | null;
  expiresAt: string;
}

export interface AssetMediaUrlRow {
  media: AssetMedia;
  kind: GraphAssetKind;
  status: "ready" | "pending";
  remote_url: string | null;
  storage_key: string | null;
  storage_bucket?: string | null;
  visibility?: "public" | "private" | null;
}

interface WorkspaceAssetJoinRow extends AssetRow {
  projects?: { name: string; status: "active" | "deleted" };
}

const MEDIA_URL_EXPIRES_IN_SEC = 60 * 60;

function mediaUrlExpiresAt(now: () => Date = () => new Date()): string {
  return new Date(now().getTime() + MEDIA_URL_EXPIRES_IN_SEC * 1000).toISOString();
}

export async function assetMediaUrlsForRow(
  row: AssetMediaUrlRow,
  opts: { now?: () => Date } = {}
): Promise<AssetMediaUrls> {
  let url: string | null = null;
  if (row.status === "ready" && row.media !== "data") {
    try {
      url = (await resolveAssetUrl(row, { privateTtlSec: MEDIA_URL_EXPIRES_IN_SEC })) ?? null;
    } catch {
      url = row.remote_url;
    }
  }

  return {
    url,
    thumbnailUrl: assetMediaToKind(row.media, row.kind) === "image" ? url : null,
    expiresAt: mediaUrlExpiresAt(opts.now),
  };
}

export async function getAssetMediaUrls(
  workspaceId: string,
  assetId: string
): Promise<AssetMediaUrls> {
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("assets")
    .select("*")
    .eq("id", assetId)
    .eq("workspace_id", workspaceId)
    .neq("media", "data")
    .maybeSingle();
  if (isNoRows(error)) throw notFound(`Asset not found: ${assetId}`);
  throwOnError(error, "getAssetMediaUrls");
  if (!data) throw notFound(`Asset not found: ${assetId}`);

  const row = data as AssetRow;
  return assetMediaUrlsForRow(row);
}

export async function listWorkspaceAssets(
  workspaceId: string,
  opts: { kind?: AssetKind; source?: "uploaded" | "generated"; projectId?: string },
  limit: number,
  cursor: string | null
): Promise<PageResult<WorkspaceAssetSummary>> {
  const db = getServiceSupabase();
  let query = db
    .from("assets")
    .select("*, projects!inner(name, status)")
    .eq("workspace_id", workspaceId)
    .neq("projects.status", "deleted")
    .neq("media", "data");
  if (opts.kind) query = query.eq("media", opts.kind);
  if (opts.projectId) query = query.eq("project_id", opts.projectId);

  const { data, error } = await query;
  throwOnError(error, "listWorkspaceAssets");
  const filtered = (data as WorkspaceAssetJoinRow[]).filter((row) => {
    const isGenerated = row.params?.provenance != null;
    if (opts.source === "generated") return isGenerated;
    if (opts.source === "uploaded") return !isGenerated;
    return true;
  });
  const all: WorkspaceAssetSummary[] = filtered.map((row) => {
    const source = row.source as { type?: string } | null;
    return {
      id: row.id,
      assetId: row.id,
      projectId: row.project_id,
      projectName: row.projects?.name ?? "Untitled project",
      kind: assetMediaToKind(row.media, row.kind),
      status: row.status,
      source: typeof source?.type === "string" ? source.type : "imported",
      filename: row.filename,
      description: row.description ?? undefined,
      durationSec: row.duration_sec ?? undefined,
      visibility: row.visibility ?? "public",
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  });
  const paged = paginate(all, limit, cursor);
  // Resolve display URLs for the returned page only — private-asset URLs are
  // presigned per call, so hydrating the full workspace list would be wasted
  // signing work.
  const rowById = new Map(filtered.map((row) => [row.id, row]));
  const items = await Promise.all(
    paged.items.map(async (item) => {
      const row = rowById.get(item.id);
      if (!row) return item;
      const media = await assetMediaUrlsForRow(row);
      return {
        ...item,
        url: media.url ?? undefined,
        thumbnailUrl: media.thumbnailUrl ?? undefined,
      };
    })
  );
  return { items, nextCursor: paged.nextCursor };
}

// ---------------------------------------------------------------------------
// Workspace-scoped cross-project lists (dashboard nav: Projects/Runs, Outputs)
// ---------------------------------------------------------------------------
// These aggregate per-project records across every active project in a
// workspace, mirroring listWorkspaceAssets' tenancy model: the workspace's
// projects are the RLS-scoped set, and each list joins the owning project's
// name onto every row so the dashboard can render "<project> — <run/output>"
// without a second lookup. The project enumeration is injectable so the
// aggregation can be unit-tested without Supabase (the route always uses the
// real, RLS-scoped listProjects).

interface WorkspaceProjectRef {
  id: string;
  name: string;
}

// Enumerate the workspace's active projects as {id, name} refs. Pulls the full
// set (the per-project run/output reads dominate the cost, and pagination is
// applied to the flattened result, not the project list).
async function listWorkspaceProjectRefs(
  workspaceId: string
): Promise<WorkspaceProjectRef[]> {
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("projects")
    .select("id, name")
    .eq("workspace_id", workspaceId)
    .neq("status", "deleted");
  throwOnError(error, "listWorkspaceProjectRefs");
  return ((data as { id: string; name: string }[]) ?? []).map((row) => ({
    id: row.id,
    name: row.name ?? "Untitled project",
  }));
}

// A generation run plus its owning project's name, for the cross-project
// Projects/Runs view. The wire shape is `GenerationRun & { projectName }`,
// matching the web client's WorkspaceGenerationRun.
export interface WorkspaceGenerationRunSummary extends GenerationRun {
  projectName: string;
}

export interface ListWorkspaceGenerationRunsDeps {
  listProjects: (workspaceId: string) => Promise<WorkspaceProjectRef[]>;
  runStore: GenerationRunsStore;
}

export async function listWorkspaceGenerationRuns(
  workspaceId: string,
  opts: { status?: GenerationRunStatus; projectId?: string },
  limit: number,
  cursor: string | null,
  deps: ListWorkspaceGenerationRunsDeps = {
    listProjects: listWorkspaceProjectRefs,
    runStore: getGenerationRunStore(),
  }
): Promise<PageResult<WorkspaceGenerationRunSummary>> {
  const projects = await deps.listProjects(workspaceId);
  const scoped = opts.projectId
    ? projects.filter((p) => p.id === opts.projectId)
    : projects;

  const perProject = await Promise.all(
    scoped.map(async (project) => {
      const runs = await deps.runStore.listRunsForProject(project.id);
      return runs.map((run) => ({ ...run, projectName: project.name }));
    })
  );

  let all = perProject.flat();
  if (opts.status) {
    all = all.filter((run) => run.status === opts.status);
  }
  // paginate() keys on { id, createdAt }; runs expose runId, so adapt the cursor
  // shape to the run's id without leaking an extra field into the wire output.
  const paged = paginate(
    all.map((run) => ({ ...run, id: run.runId })),
    limit,
    cursor
  );
  return {
    items: paged.items.map(({ id: _id, ...run }) => {
      void _id;
      return run;
    }),
    nextCursor: paged.nextCursor,
  };
}

// A rendered/export artifact plus its owning project's name, for the Outputs
// view (where Created Videos relocate). Maps the agent-api export Artifact onto
// the web client's WorkspaceOutput shape.
export interface WorkspaceOutputSummary {
  artifactId: string;
  projectId: string;
  projectName: string;
  timelineId?: string;
  url?: string;
  durationSec?: number;
  format?: string;
  createdAt: string;
}

export interface ProjectWatchMedia {
  assetId: string;
  projectId: string;
  projectName: string;
  filename: string;
  kind: "video";
  url: string;
  posterUrl?: string;
  durationSec?: number;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ListWorkspaceOutputsDeps {
  listProjects: (workspaceId: string) => Promise<WorkspaceProjectRef[]>;
  artifactStore: Pick<AgentApiStore, "listArtifactsForProject">;
}

export async function listWorkspaceOutputs(
  workspaceId: string,
  opts: { projectId?: string },
  limit: number,
  cursor: string | null,
  deps: ListWorkspaceOutputsDeps = {
    listProjects: listWorkspaceProjectRefs,
    artifactStore: agentApiStore,
  }
): Promise<PageResult<WorkspaceOutputSummary>> {
  const projects = await deps.listProjects(workspaceId);
  const scoped = opts.projectId
    ? projects.filter((p) => p.id === opts.projectId)
    : projects;

  const perProject = await Promise.all(
    scoped.map(async (project) => {
      const artifacts = await deps.artifactStore.listArtifactsForProject(
        project.id
      );
      return artifacts
        .filter((artifact) => artifact.status === "ready")
        .map<WorkspaceOutputSummary>((artifact) => ({
          artifactId: artifact.id,
          projectId: project.id,
          projectName: project.name,
          timelineId: artifact.timelineId,
          url: artifact.url ?? undefined,
          durationSec: artifact.durationSec,
          format: artifact.renderPlan?.format,
          createdAt: artifact.createdAt,
        }));
    })
  );

  const all = perProject.flat();
  // paginate() keys on { id, createdAt }; outputs expose artifactId.
  const paged = paginate(
    all.map((output) => ({ ...output, id: output.artifactId })),
    limit,
    cursor
  );
  return {
    items: paged.items.map(({ id: _id, ...output }) => {
      void _id;
      return output;
    }),
    nextCursor: paged.nextCursor,
  };
}

async function projectedAssetUrl(
  row: Pick<AssetRow, "remote_url" | "storage_key" | "storage_bucket" | "visibility">
): Promise<{
  url: string | null;
  expiresAt?: string;
}> {
  if (row.storage_key) {
    const expiresInSec = 3600;
    try {
      return {
        url:
          (await resolveAssetUrl(row, {
            privateTtlSec: expiresInSec,
          })) ?? row.remote_url,
        expiresAt: new Date(Date.now() + expiresInSec * 1000).toISOString(),
      };
    } catch {
      return { url: row.remote_url };
    }
  }

  return { url: row.remote_url };
}

async function selectedMediaAsset(
  db: SupabaseClient,
  projectId: string,
  slotRole: string,
  media: AssetMedia
): Promise<AssetRow | null> {
  let selectionQuery = db
    .from("current_selections")
    .select("active_asset_id, seq")
    .eq("project_id", projectId)
    .eq("slot_role", slotRole);

  if (slotRole === "cut" || slotRole === "poster") {
    selectionQuery = selectionQuery.is("slot_owner_lineage_id", null);
  }

  const selected = await selectionQuery
    .order("seq", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (isNoRows(selected.error)) return null;
  throwOnError(selected.error, `selectedMediaAsset ${slotRole}`);

  const activeAssetId = (selected.data as CurrentSelectionRow | null)?.active_asset_id;
  if (!activeAssetId) return null;

  const { data, error } = await db
    .from("assets")
    .select("*")
    .eq("project_id", projectId)
    .eq("id", activeAssetId)
    .eq("media", media)
    .eq("status", "ready")
    .maybeSingle();
  if (isNoRows(error)) return null;
  throwOnError(error, `selectedMediaAsset asset ${slotRole}`);
  return (data as AssetRow | null) ?? null;
}

async function latestReadyMediaAsset(
  db: SupabaseClient,
  projectId: string,
  kind: GraphAssetKind,
  media: AssetMedia
): Promise<AssetRow | null> {
  const { data, error } = await db
    .from("assets")
    .select("*")
    .eq("project_id", projectId)
    .eq("kind", kind)
    .eq("media", media)
    .eq("status", "ready")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (isNoRows(error)) return null;
  throwOnError(error, `latestReadyMediaAsset ${kind}`);
  return (data as AssetRow | null) ?? null;
}

async function renderForCutAsset(
  db: SupabaseClient,
  projectId: string,
  cutAssetId: string
): Promise<AssetRow | null> {
  const edgeRows = await db
    .from("asset_edges")
    .select("from_id")
    .eq("project_id", projectId)
    .eq("to_id", cutAssetId);
  throwOnError(edgeRows.error, "renderForCutAsset edges");

  const renderIds = [...new Set(((edgeRows.data ?? []) as Array<{ from_id: string }>).map((row) => row.from_id))];
  if (renderIds.length === 0) return null;

  const { data, error } = await db
    .from("assets")
    .select("*")
    .eq("project_id", projectId)
    .eq("kind", "render")
    .eq("media", "video")
    .eq("status", "ready")
    .in("id", renderIds)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (isNoRows(error)) return null;
  throwOnError(error, "renderForCutAsset render");
  return (data as AssetRow | null) ?? null;
}

export async function getProjectWatchMedia(
  workspaceId: string,
  projectId: string
): Promise<ProjectWatchMedia | null> {
  const project = await getProject(workspaceId, projectId);
  const db = getServiceSupabase();
  const directRender = await selectedMediaAsset(db, projectId, "cut", "video");
  const cut = directRender ? null : await selectedDataAsset(db, projectId, "cut", "composite");
  const render = directRender ?? (cut ? await renderForCutAsset(db, projectId, cut.id) : null);
  if (!render || render.kind !== "render") return null;

  const media = await projectedAssetUrl(render);
  if (!media.url) return null;

  const posterAsset =
    (await selectedMediaAsset(db, projectId, "poster", "image")) ??
    (await latestReadyMediaAsset(db, projectId, "keyframe", "image"));
  const poster = posterAsset ? await projectedAssetUrl(posterAsset) : { url: null };

  return {
    assetId: render.id,
    projectId,
    projectName: project.name,
    filename: render.filename,
    kind: "video",
    url: media.url,
    ...(poster.url ? { posterUrl: poster.url } : {}),
    ...(render.duration_sec != null ? { durationSec: render.duration_sec } : {}),
    ...(media.expiresAt ? { expiresAt: media.expiresAt } : {}),
    createdAt: iso(render.created_at),
    updatedAt: iso(render.updated_at),
  };
}

export interface GetWorkspaceDashboardSummaryDeps {
  listProjects: (workspaceId: string) => Promise<WorkspaceProjectRef[]>;
  runStore: GenerationRunsStore;
  artifactStore: Pick<AgentApiStore, "listArtifactsForProject">;
}

const ACTIVE_RUN_STATUSES: GenerationRunStatus[] = ["queued", "running"];
const DASHBOARD_ACTIVE_RUN_LIMIT = 5;
const DASHBOARD_RECENT_OUTPUT_LIMIT = 6;

export async function getWorkspaceDashboardSummary(
  workspaceId: string,
  deps: GetWorkspaceDashboardSummaryDeps = {
    listProjects: listWorkspaceProjectRefs,
    runStore: getGenerationRunStore(),
    artifactStore: agentApiStore,
  }
): Promise<DashboardSummary> {
  const projects = await deps.listProjects(workspaceId);
  const listProjectsOnce = async () => projects;

  const [runsPage, outputsPage] = await Promise.all([
    listWorkspaceGenerationRuns(
      workspaceId,
      {},
      Number.MAX_SAFE_INTEGER,
      null,
      { listProjects: listProjectsOnce, runStore: deps.runStore }
    ),
    listWorkspaceOutputs(
      workspaceId,
      {},
      Number.MAX_SAFE_INTEGER,
      null,
      { listProjects: listProjectsOnce, artifactStore: deps.artifactStore }
    ),
  ]);

  const activeRuns = runsPage.items.filter((run) =>
    ACTIVE_RUN_STATUSES.includes(run.status)
  );

  return {
    schemaVersion: DASHBOARD_SCHEMA_VERSION,
    counts: {
      projects: projects.length,
      activeRuns: activeRuns.length,
      outputs: outputsPage.items.length,
    },
    activeRuns: activeRuns.slice(0, DASHBOARD_ACTIVE_RUN_LIMIT).map((run) => ({
      runId: run.runId,
      projectId: run.projectId,
      projectName: run.projectName,
      status: run.status,
      reviewGate: run.reviewGate ?? null,
      currentStageType: run.currentStageType,
      progressPercent: run.progressPercent,
      updatedAt: run.updatedAt,
    })),
    recentOutputs: outputsPage.items
      .slice(0, DASHBOARD_RECENT_OUTPUT_LIMIT)
      .map((output) => ({
        artifactId: output.artifactId,
        projectId: output.projectId,
        projectName: output.projectName,
        timelineId: output.timelineId,
        url: output.url,
        durationSec: output.durationSec,
        format: output.format,
        createdAt: output.createdAt,
      })),
  };
}
export async function listPublicAssets(
  limit: number,
  cursor: string | null,
  kind?: AssetKind
): Promise<PageResult<V1Asset>> {
  const db = getServiceSupabase();
  let query = db
    .from("assets")
    .select("*, projects!inner(id, visibility, status)")
    .eq("visibility", "public")
    .eq("projects.visibility", "public")
    .neq("projects.status", "deleted")
    .neq("media", "data");

  if (kind) {
    query = query.eq("media", kind);
  }

  const { data, error } = await query;
  throwOnError(error, "listPublicAssets");
  const assets = await mapAssets(data as AssetWithProjectRow[]);
  return paginate(assets, limit, cursor);
}

export type DiscoverSearchItem =
  | { type: "project"; item: V1Project; id: string; createdAt: string }
  | { type: "asset"; item: V1Asset; id: string; createdAt: string };

export async function searchPublicContent(
  searchQuery: string,
  limit: number,
  cursor: string | null,
  kind?: AssetKind
): Promise<PageResult<DiscoverSearchItem>> {
  const db = getServiceSupabase();
  const normalized = searchQuery.trim();
  if (!normalized) return { items: [], nextCursor: null };

  const [projectsResult, assetsResult] = await Promise.all([
    db.rpc("search_public_projects", { search_query: normalized }),
    db.rpc("search_public_assets", {
      search_query: normalized,
      media_filter: kind ?? null,
    }),
  ]);

  throwOnError(projectsResult.error, "searchPublicContent projects");
  throwOnError(assetsResult.error, "searchPublicContent assets");

  const projectItems: DiscoverSearchItem[] = (projectsResult.data as ProjectRow[])
    .map((project) => {
      const item = mapProject(project);
      return { type: "project", item, id: `project:${item.id}`, createdAt: item.createdAt };
    });
  const publicAssets = await mapAssets(assetsResult.data as AssetRow[]);
  const assetItems: DiscoverSearchItem[] = publicAssets.map((item) => ({
    type: "asset",
    item,
    id: `asset:${item.id}`,
    createdAt: item.createdAt,
  }));

  return paginate([...projectItems, ...assetItems], limit, cursor);
}

function isCharacterAnchorAsset(asset: V1Asset): boolean {
  return Boolean(
    asset.userContext?.characterNames?.length ||
      asset.userContext?.intendedUse?.includes("character_reference") ||
      asset.context?.recommendedRoles?.some((role) => /character/i.test(role))
  );
}

export async function listCharacterAnchorAssets(
  workspaceId: string,
  projectId: string,
  limit: number,
  cursor: string | null
): Promise<PageResult<V1Asset>> {
  await getProject(workspaceId, projectId);
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("assets")
    .select("*")
    .eq("project_id", projectId)
    .eq("workspace_id", workspaceId)
    .neq("media", "data");
  throwOnError(error, "listCharacterAnchorAssets");
  const mapped = await mapAssets(data as AssetRow[]);
  const anchors = mapped.filter(isCharacterAnchorAsset);
  return paginate(anchors, limit, cursor);
}

// ---------------------------------------------------------------------------
// Compositions and jobs
// ---------------------------------------------------------------------------
interface CompositionRow {
  id: string;
  schema_version: string;
  project_id: string;
  brief_version_id: string | null;
  mode: ContractCompositionPlan["mode"];
  status: ContractCompositionPlan["status"];
  planned_beats: ContractCompositionPlan["plannedBeats"];
  generated_asset_job_ids: string[];
  ready_asset_ids: string[];
  narration_strategy: ContractCompositionPlan["narrationStrategy"] | null;
  created_at: string;
  updated_at: string;
}

function compositionToRow(composition: ContractCompositionPlan): CompositionRow {
  return {
    id: composition.id,
    schema_version: composition.schemaVersion,
    project_id: composition.projectId,
    brief_version_id: composition.briefVersionId || null,
    mode: composition.mode,
    status: composition.status,
    planned_beats: composition.plannedBeats,
    generated_asset_job_ids: composition.generatedAssetJobIds,
    ready_asset_ids: composition.readyAssetIds,
    narration_strategy: composition.narrationStrategy ?? null,
    created_at: composition.createdAt,
    updated_at: composition.updatedAt,
  };
}

function mapComposition(row: CompositionRow): ContractCompositionPlan {
  return {
    id: row.id,
    schemaVersion: CONTRACT_SCHEMA.composition,
    projectId: row.project_id,
    briefVersionId: row.brief_version_id ?? "",
    mode: row.mode,
    status: row.status,
    plannedBeats: row.planned_beats ?? [],
    generatedAssetJobIds: row.generated_asset_job_ids ?? [],
    readyAssetIds: row.ready_asset_ids ?? [],
    narrationStrategy: row.narration_strategy ?? undefined,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

interface JobRow {
  id: string;
  schema_version: string;
  workspace_id: string;
  project_id: string;
  request_id: string | null;
  type: JobType;
  status: JobStatus;
  progress: Job["progress"];
  input: unknown;
  result: unknown;
  error: Job["error"];
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
}

function jobToRow(job: Job): JobRow {
  return {
    id: job.id,
    schema_version: job.schemaVersion,
    workspace_id: job.workspaceId,
    project_id: job.projectId,
    request_id: job.requestId ?? null,
    type: job.type,
    status: job.status,
    progress: job.progress,
    input: job.input,
    result: job.result,
    error: job.error,
    idempotency_key: job.idempotencyKey ?? null,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
  };
}

function mapJob(row: JobRow): Job {
  return {
    id: row.id,
    schemaVersion: CONTRACT_SCHEMA.job,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    requestId: row.request_id ?? undefined,
    type: row.type,
    status: row.status,
    progress: row.progress ?? {},
    input: row.input ?? null,
    result: row.result ?? null,
    error: row.error ?? null,
    idempotencyKey: row.idempotency_key ?? undefined,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export async function saveCompositionPlan(
  workspaceId: string,
  composition: ContractCompositionPlan
): Promise<ContractCompositionPlan> {
  await getProject(workspaceId, composition.projectId);
  const db = getServiceSupabase();
  // Omit `id` so Postgres assigns it; the caller's composition.id is a placeholder.
  const { id: _omit, ...row } = compositionToRow(composition);
  void _omit;
  const { data, error } = await db
    .from("compositions")
    .insert(row)
    .select("*")
    .single();
  throwOnError(error, "saveCompositionPlan");
  return mapComposition(data as CompositionRow);
}

export async function getCompositionPlan(
  workspaceId: string,
  projectId: string,
  compositionId: string
): Promise<ContractCompositionPlan> {
  await getProject(workspaceId, projectId);
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("compositions")
    .select("*")
    .eq("id", compositionId)
    .eq("project_id", projectId)
    .maybeSingle();
  if (isNoRows(error)) throw notFound(`Composition not found: ${compositionId}`);
  throwOnError(error, "getCompositionPlan");
  if (!data) throw notFound(`Composition not found: ${compositionId}`);
  return mapComposition(data as CompositionRow);
}

export async function listCompositionPlans(
  workspaceId: string,
  projectId: string,
  limit: number,
  cursor: string | null
): Promise<PageResult<ContractCompositionPlan>> {
  await getProject(workspaceId, projectId);
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("compositions")
    .select("*")
    .eq("project_id", projectId);
  throwOnError(error, "listCompositionPlans");
  const all = (data as CompositionRow[]).map(mapComposition);
  return paginate(all, limit, cursor);
}

export async function createJob(input: {
  workspaceId: string;
  projectId: string;
  type: JobType;
  status?: JobStatus;
  requestId?: string;
  payload?: unknown;
  result?: unknown;
}): Promise<Job> {
  await getProject(input.workspaceId, input.projectId);
  const now = new Date().toISOString();
  const job: Job = {
    // Placeholder id; the row is inserted without it and the DB-generated id is
    // read back below.
    id: "",
    schemaVersion: CONTRACT_SCHEMA.job,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    requestId: input.requestId,
    type: input.type,
    status: input.status ?? "queued",
    progress: {
      percent: input.status === "succeeded" ? 100 : 0,
      currentStep: input.status === "succeeded" ? "completed" : "queued",
    },
    input: input.payload ?? null,
    result: input.result ?? null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  const db = getServiceSupabase();
  const { id: _omit, ...row } = jobToRow(job);
  void _omit;
  const { data, error } = await db
    .from("jobs")
    .insert(row)
    .select("*")
    .single();
  throwOnError(error, "createJob");
  return mapJob(data as JobRow);
}

export async function getJob(
  workspaceId: string,
  projectId: string,
  jobId: string
): Promise<Job> {
  await getProject(workspaceId, projectId);
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("jobs")
    .select("*")
    .eq("id", jobId)
    .eq("project_id", projectId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (isNoRows(error)) throw notFound(`Job not found: ${jobId}`);
  throwOnError(error, "getJob");
  if (!data) throw notFound(`Job not found: ${jobId}`);
  return mapJob(data as JobRow);
}

export async function listJobs(
  workspaceId: string,
  projectId: string,
  type: JobType | null,
  limit: number,
  cursor: string | null
): Promise<PageResult<Job>> {
  await getProject(workspaceId, projectId);
  const db = getServiceSupabase();
  let query = db
    .from("jobs")
    .select("*")
    .eq("project_id", projectId)
    .eq("workspace_id", workspaceId);
  if (type !== null) {
    query = query.eq("type", type);
  }
  const { data, error } = await query;
  throwOnError(error, "listJobs");
  const all = (data as JobRow[]).map(mapJob);
  return paginate(all, limit, cursor);
}

export async function getProjectManifest(
  workspaceId: string,
  projectId: string
): Promise<unknown> {
  await getProject(workspaceId, projectId);
  const db = getRequestSupabaseOrService();
  const { data, error } = await db.rpc("project_manifest", {
    p_project_id: projectId,
  });
  throwOnError(error, "getProjectManifest");
  return data ?? {};
}

export async function getStaleCandidates(
  workspaceId: string,
  projectId: string,
  changedAssetId: string
): Promise<StaleCandidatesResult> {
  await getProject(workspaceId, projectId);
  const db = getRequestSupabaseOrService();

  const changed = await db
    .from("assets")
    .select("id, ref, kind, status, role, lineage_id, version, content_hash, inputs_fingerprint")
    .eq("id", changedAssetId)
    .eq("project_id", projectId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (isNoRows(changed.error)) {
    throw notFound(`Asset not found: ${changedAssetId}`);
  }
  throwOnError(changed.error, "getStaleCandidates.changedAsset");
  if (!changed.data) {
    throw notFound(`Asset not found: ${changedAssetId}`);
  }
  const changedAsset = changed.data as GraphAssetSummaryRow;

  const downstream = await db.rpc("downstream_assets", {
    p_asset_id: changedAssetId,
  });
  throwOnError(downstream.error, "getStaleCandidates.downstreamAssets");
  const rows = ((downstream.data ?? []) as DownstreamAssetRow[]).sort(
    (a, b) => a.depth - b.depth || a.asset_id.localeCompare(b.asset_id)
  );
  const candidateIds = rows.map((row) => row.asset_id);
  if (candidateIds.length === 0) {
    return {
      changedAsset: {
        assetId: changedAsset.id,
        ref: changedAsset.ref,
        kind: changedAsset.kind,
        contentHash: changedAsset.content_hash,
      },
      candidates: [],
    };
  }

  const [assetsResult, selectionsResult] = await Promise.all([
    db
      .from("assets")
      .select("id, ref, kind, status, role, lineage_id, version, content_hash, inputs_fingerprint")
      .eq("project_id", projectId)
      .eq("workspace_id", workspaceId)
      .in("id", candidateIds),
    db
      .from("current_selections")
      .select("slot_owner_lineage_id, slot_role, seq, active_asset_id")
      .eq("project_id", projectId)
      .in("active_asset_id", candidateIds),
  ]);
  throwOnError(assetsResult.error, "getStaleCandidates.assets");
  throwOnError(selectionsResult.error, "getStaleCandidates.selections");

  const assetsById = new Map(
    ((assetsResult.data ?? []) as GraphAssetSummaryRow[]).map((asset) => [
      asset.id,
      asset,
    ])
  );
  const selectionsByAssetId = new Map<string, AssetGraphSelectionRef[]>();
  for (const selection of (selectionsResult.data ?? []) as CurrentSelectionSummaryRow[]) {
    const refs = selectionsByAssetId.get(selection.active_asset_id) ?? [];
    refs.push({
      slotOwnerLineageId: selection.slot_owner_lineage_id,
      slotRole: selection.slot_role,
      seq: selection.seq,
    });
    selectionsByAssetId.set(selection.active_asset_id, refs);
  }

  return {
    changedAsset: {
      assetId: changedAsset.id,
      ref: changedAsset.ref,
      kind: changedAsset.kind,
      contentHash: changedAsset.content_hash,
    },
    candidates: rows.flatMap((row) => {
      const asset = assetsById.get(row.asset_id);
      if (!asset) return [];
      return [
        {
          assetId: asset.id,
          depth: row.depth,
          ref: asset.ref,
          kind: asset.kind,
          status: asset.status,
          role: asset.role,
          lineageId: asset.lineage_id,
          version: asset.version,
          contentHash: asset.content_hash,
          inputsFingerprint: asset.inputs_fingerprint,
          selections: selectionsByAssetId.get(asset.id) ?? [],
        },
      ];
    }),
  };
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------
interface IdempotencyRow {
  scope: string;
  key: string;
  body_hash: string | null;
  status: number | null;
  response_body: unknown;
  created_at: string;
}

function mapIdempotency(row: IdempotencyRow): IdempotencyRecord {
  return {
    scope: row.scope,
    key: row.key,
    bodyHash: row.body_hash ?? "",
    status: row.status ?? 0,
    responseBody: row.response_body,
    createdAt: iso(row.created_at),
  };
}

export async function findIdempotencyRecord(
  scope: string,
  key: string
): Promise<IdempotencyRecord | undefined> {
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("idempotency")
    .select("*")
    .eq("scope", scope)
    .eq("key", key)
    .maybeSingle();
  if (isNoRows(error)) return undefined;
  throwOnError(error, "findIdempotencyRecord");
  if (!data) return undefined;
  return mapIdempotency(data as IdempotencyRow);
}

export async function saveIdempotencyRecord(
  record: IdempotencyRecord
): Promise<void> {
  const db = getServiceSupabase();
  // First write wins (matching the JSON store's "does not duplicate" semantics):
  // ignore the conflict on the (scope, key) primary key.
  const { error } = await db
    .from("idempotency")
    .upsert(
      {
        scope: record.scope,
        key: record.key,
        body_hash: record.bodyHash,
        status: record.status,
        response_body: record.responseBody,
        created_at: record.createdAt,
      },
      { onConflict: "scope,key", ignoreDuplicates: true }
    );
  throwOnError(error, "saveIdempotencyRecord");
}
