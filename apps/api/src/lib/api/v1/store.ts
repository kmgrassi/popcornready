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
import path from "path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { EditPlan } from "@popcorn/shared/types";
import { isMissingRow, throwDatabaseError } from "../../supabase/db-errors";
import {
  DASHBOARD_SCHEMA_VERSION,
  type DashboardSummary,
} from "@popcorn/shared/v1/dashboard";
import { notFound } from "./errors";
import { GeneratedAssetProvenance } from "./provenance";
import { AssetSemanticAnalysis } from "../../edit-graph/types";
import {
  type CompositionPlan as ContractCompositionPlan,
  type GenerationRun,
  type GenerationRunStatus,
  type Job,
  type JobStatus,
  type JobType,
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
import { agentApiStore, type AgentApiStore } from "../../agent-api/jobs";
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
  brief: VideoBrief | null;
  currentBriefVersionId: string | null;
  // Editable storyboard plan (Scenes -> Beats). Null until a plan exists.
  plan: EditPlan | null;
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

// ---------------------------------------------------------------------------
// Helpers: timestamps, errors, mapping
// ---------------------------------------------------------------------------

// Normalize a DB timestamptz (or any date-ish value) to canonical ISO so cursor
// pagination ordering is stable across the JSON-string and Postgres backends.
function iso(value: string | null | undefined): string {
  if (!value) return new Date(0).toISOString();
  return new Date(value).toISOString();
}

// supabase-js returns `PGRST116` when a `.single()` lookup matches no rows.
// Callers translate that into notFound/null; other DB failures use the typed
// database_error envelope instead of leaking as generic internal errors.
const isNoRows = isMissingRow;
const throwOnError = (error: Parameters<typeof throwDatabaseError>[1], context: string) =>
  throwDatabaseError(`store.${context}`, error);

async function defaultVisibilityForWorkspace(
  db: SupabaseClient,
  workspaceId: string
): Promise<"public" | "private"> {
  const { data, error } = await db.rpc("owner_tier", { ws_id: workspaceId });
  throwOnError(error, "defaultVisibilityForWorkspace");
  return data === "paid" ? "private" : "public";
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
  brief: VideoBrief | null;
  current_brief_version_id: string | null;
  plan: EditPlan | null;
  visibility?: "public" | "private";
  created_at: string;
  updated_at: string;
}

function mapProject(row: ProjectRow): V1Project {
  return {
    id: row.id,
    schemaVersion: SCHEMA_VERSIONS.project,
    workspaceId: row.workspace_id,
    name: row.name,
    status: row.status,
    brief: row.brief ?? null,
    currentBriefVersionId: row.current_brief_version_id ?? null,
    plan: row.plan ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

// --- brief versions --------------------------------------------------------
interface BriefVersionRow {
  id: string;
  schema_version: string;
  project_id: string;
  brief: VideoBrief;
  created_at: string;
}

function mapBriefVersion(row: BriefVersionRow): V1BriefVersion {
  return {
    id: row.id,
    schemaVersion: SCHEMA_VERSIONS.briefVersion,
    projectId: row.project_id,
    brief: row.brief,
    createdAt: iso(row.created_at),
  };
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

interface AssetRow {
  id: string;
  schema_version: string;
  workspace_id: string;
  project_id: string;
  kind: AssetKind;
  status: "ready" | "pending";
  filename: string;
  remote_url: string | null;
  storage_key: string | null;
  source: AgentAssetSource;
  duration_sec: number | null;
  description: string | null;
  context: AssetContextEnvelope | null;
  semantic_analysis: AssetSemanticAnalysis | null;
  provenance: GeneratedAssetProvenance | null;
  visibility?: "public" | "private";
  created_at: string;
  updated_at: string;
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
  return {
    id: asset.id,
    schema_version: asset.schemaVersion,
    workspace_id: asset.workspaceId,
    project_id: asset.projectId,
    kind: asset.kind,
    status: asset.status,
    filename: asset.filename,
    remote_url: asset.remoteUrl ?? null,
    storage_key: asset.storageKey ?? null,
    source: asset.source,
    duration_sec: asset.durationSec ?? null,
    description: asset.userContext?.description ?? asset.context?.summary ?? null,
    context: assetContextEnvelope(asset),
    semantic_analysis: asset.semanticAnalysis ?? null,
    provenance: asset.provenance ?? null,
    created_at: asset.createdAt,
    updated_at: asset.updatedAt,
  };
}

function mapAsset(row: AssetRow): V1Asset {
  const envelope = row.context ?? {};
  const asset: V1Asset = {
    id: row.id,
    schemaVersion: SCHEMA_VERSIONS.asset,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    kind: row.kind,
    filename: row.filename,
    status: row.status,
    source: row.source,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
  if (row.remote_url != null) asset.remoteUrl = row.remote_url;
  if (row.storage_key != null) asset.storageKey = row.storage_key;
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
  if (row.provenance != null) asset.provenance = row.provenance;
  if (row.visibility != null) asset.visibility = row.visibility;
  return asset;
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

  // FK ordering: brief_versions.project_id -> projects.id (NOT NULL), and
  // projects.current_brief_version_id -> brief_versions.id. So insert the project
  // first (with a null current_brief_version_id), then the brief version, then
  // point the project at it. Ids are DB-generated (gen_random_uuid); omit `id`
  // and read the generated value back via .select().
  const insertedProject = await db
    .from("projects")
    .insert({
      schema_version: SCHEMA_VERSIONS.project,
      workspace_id: input.workspaceId,
      name: input.name,
      status: "active",
      brief: input.brief ?? null,
      visibility,
      current_brief_version_id: null,
      created_at: now,
      updated_at: now,
    })
    .select("*")
    .single();
  throwOnError(insertedProject.error, "createProject insert project");
  let projectRow = insertedProject.data as ProjectRow;
  const projectId = projectRow.id;

  let briefVersion: V1BriefVersion | null = null;
  if (input.brief) {
    const insertedBrief = await db
      .from("brief_versions")
      .insert({
        schema_version: SCHEMA_VERSIONS.briefVersion,
        project_id: projectId,
        brief: input.brief,
        created_at: now,
      })
      .select("*")
      .single();
    throwOnError(insertedBrief.error, "createProject insert brief_version");
    briefVersion = mapBriefVersion(insertedBrief.data as BriefVersionRow);

    const updatedProject = await db
      .from("projects")
      .update({ current_brief_version_id: briefVersion.id, updated_at: now })
      .eq("id", projectId)
      .select("*")
      .single();
    throwOnError(updatedProject.error, "createProject link brief_version");
    projectRow = updatedProject.data as ProjectRow;
  }

  return { project: mapProject(projectRow), briefVersion };
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
  return mapProject(data as ProjectRow);
}

// Persist the project's editable storyboard plan (Scenes -> Beats). Replaces the
// whole plan; callers (the storyboard editor) keep scene/beat ids stable across
// edits so downstream assets/provenance keep referencing the same nodes.
export async function updateProjectPlan(
  workspaceId: string,
  projectId: string,
  plan: EditPlan
): Promise<V1Project> {
  const db = getServiceSupabase();
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("projects")
    .update({ plan, updated_at: now })
    .eq("id", projectId)
    .eq("workspace_id", workspaceId)
    .neq("status", "deleted")
    .select("*")
    .maybeSingle();
  if (isNoRows(error)) throw notFound(`Project not found: ${projectId}`);
  throwOnError(error, "updateProjectPlan");
  if (!data) throw notFound(`Project not found: ${projectId}`);
  return mapProject(data as ProjectRow);
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
  const all = (data as ProjectRow[]).map(mapProject);
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
  return paginate((data as ProjectRow[]).map(mapProject), limit, cursor);
}

export async function setBrief(
  workspaceId: string,
  projectId: string,
  brief: VideoBrief
): Promise<V1Project> {
  const db = getServiceSupabase();
  // Enforce tenancy: only update a row that matches both ids and is not deleted.
  const { data, error } = await db
    .from("projects")
    .update({ brief, updated_at: new Date().toISOString() })
    .eq("id", projectId)
    .eq("workspace_id", workspaceId)
    .neq("status", "deleted")
    .select("*")
    .maybeSingle();
  if (isNoRows(error)) throw notFound(`Project not found: ${projectId}`);
  throwOnError(error, "setBrief");
  if (!data) throw notFound(`Project not found: ${projectId}`);
  return mapProject(data as ProjectRow);
}

export async function createBriefVersion(
  workspaceId: string,
  projectId: string,
  brief: VideoBrief
): Promise<{ project: V1Project; briefVersion: V1BriefVersion }> {
  // Confirm the project exists within the workspace before writing the version.
  await getProject(workspaceId, projectId);

  const db = getServiceSupabase();
  const now = new Date().toISOString();
  const insertedBrief = await db
    .from("brief_versions")
    .insert({
      schema_version: SCHEMA_VERSIONS.briefVersion,
      project_id: projectId,
      brief,
      created_at: now,
    })
    .select("*")
    .single();
  throwOnError(insertedBrief.error, "createBriefVersion insert");
  const briefVersion = mapBriefVersion(insertedBrief.data as BriefVersionRow);

  const updatedProject = await db
    .from("projects")
    .update({
      brief,
      current_brief_version_id: briefVersion.id,
      updated_at: now,
    })
    .eq("id", projectId)
    .eq("workspace_id", workspaceId)
    .neq("status", "deleted")
    .select("*")
    .single();
  throwOnError(updatedProject.error, "createBriefVersion update project");

  return { project: mapProject(updatedProject.data as ProjectRow), briefVersion };
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
    .from("brief_versions")
    .select("*")
    .eq("project_id", projectId);
  throwOnError(error, "listBriefVersions");
  const all = (data as BriefVersionRow[]).map(mapBriefVersion);
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
export async function addAsset(asset: V1Asset): Promise<V1Asset> {
  const db = getServiceSupabase();
  // Omit `id` so Postgres assigns it (gen_random_uuid); any id on the incoming
  // object is a placeholder and is read back from the inserted row.
  const { id: _omit, ...row } = assetToRow(asset);
  void _omit;
  row.visibility = await defaultVisibilityForWorkspace(db, asset.workspaceId);
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
  const { data, error } = await db
    .from("assets")
    .select("*")
    .eq("id", assetId)
    .eq("project_id", projectId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (isNoRows(error)) throw notFound(`Asset not found: ${assetId}`);
  throwOnError(error, "getAsset");
  if (!data) throw notFound(`Asset not found: ${assetId}`);
  return mapAsset(data as AssetRow);
}

export async function updateAsset(
  workspaceId: string,
  projectId: string,
  assetId: string,
  updater: (asset: V1Asset) => void
): Promise<V1Asset> {
  // Read-modify-write: load the current row (with tenancy filter), apply the
  // mutation in memory, then persist the full row back.
  const current = await getAsset(workspaceId, projectId, assetId);
  updater(current);
  current.updatedAt = new Date().toISOString();

  const db = getServiceSupabase();
  const { data, error } = await db
    .from("assets")
    .update(assetToRow(current))
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

// Flip an asset's public/private visibility. Updates only the visibility column
// (tenancy-scoped) so it never clobbers other fields. Tier gating is deferred —
// the DB visibility-tier triggers were dropped (migration 20260609000000), so any
// member of the workspace can set either value.
export async function setAssetVisibility(
  workspaceId: string,
  projectId: string,
  assetId: string,
  visibility: "public" | "private"
): Promise<V1Asset> {
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("assets")
    .update({ visibility, updated_at: new Date().toISOString() })
    .eq("id", assetId)
    .eq("project_id", projectId)
    .eq("workspace_id", workspaceId)
    .select("*")
    .maybeSingle();
  if (isNoRows(error)) throw notFound(`Asset not found: ${assetId}`);
  throwOnError(error, "setAssetVisibility");
  if (!data) throw notFound(`Asset not found: ${assetId}`);
  return mapAsset(data as AssetRow);
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
    .eq("workspace_id", workspaceId);
  throwOnError(error, "listAssets");
  const all = (data as AssetRow[]).map(mapAsset);
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
  durationSec?: number;
  visibility: "public" | "private";
  createdAt: string;
  updatedAt: string;
}

interface WorkspaceAssetJoinRow extends AssetRow {
  projects?: { name: string; status: "active" | "deleted" };
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
    .neq("projects.status", "deleted");
  if (opts.kind) query = query.eq("kind", opts.kind);
  if (opts.projectId) query = query.eq("project_id", opts.projectId);
  // "generated" assets carry provenance; uploaded/imported ones do not.
  if (opts.source === "generated") query = query.not("provenance", "is", null);
  if (opts.source === "uploaded") query = query.is("provenance", null);

  const { data, error } = await query;
  throwOnError(error, "listWorkspaceAssets");
  const all: WorkspaceAssetSummary[] = (data as WorkspaceAssetJoinRow[]).map((row) => {
    const source = row.source as { type?: string } | null;
    return {
      id: row.id,
      assetId: row.id,
      projectId: row.project_id,
      projectName: row.projects?.name ?? "Untitled project",
      kind: row.kind,
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
  return paginate(all, limit, cursor);
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
    .neq("projects.status", "deleted");

  if (kind) {
    query = query.eq("kind", kind);
  }

  const { data, error } = await query;
  throwOnError(error, "listPublicAssets");
  return paginate((data as AssetWithProjectRow[]).map(mapAsset), limit, cursor);
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
      asset_kind_filter: kind ?? null,
    }),
  ]);

  throwOnError(projectsResult.error, "searchPublicContent projects");
  throwOnError(assetsResult.error, "searchPublicContent assets");

  const projectItems: DiscoverSearchItem[] = (projectsResult.data as ProjectRow[])
    .map((project) => {
      const item = mapProject(project);
      return { type: "project", item, id: `project:${item.id}`, createdAt: item.createdAt };
    });
  const assetItems: DiscoverSearchItem[] = (assetsResult.data as AssetRow[]).map(
    (asset) => {
      const item = mapAsset(asset);
      return { type: "asset", item, id: `asset:${item.id}`, createdAt: item.createdAt };
    }
  );

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
    .eq("workspace_id", workspaceId);
  throwOnError(error, "listCharacterAnchorAssets");
  const anchors = (data as AssetRow[]).map(mapAsset).filter(isCharacterAnchorAsset);
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
