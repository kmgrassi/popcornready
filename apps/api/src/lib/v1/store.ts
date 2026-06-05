import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  BriefVersion,
  CompositionPlan,
  Job,
  V1Asset,
  V1Project,
  VersionedEditGraph,
  VersionedTimeline,
} from "@popcorn/shared/v1/types";
import { getServiceSupabase } from "./supabase-client";

// Persistence repository for /api/v1's job + timeline stack.
//
// The store reads/writes the v1 data model in Supabase Postgres (tables defined
// in supabase/migrations/20260603000000_init_v1_model.sql): compositions, jobs,
// timelines, edit_graphs, and the project/brief/asset readers. Snake_case
// columns are mapped to/from the camelCase domain objects below; loosely-shaped
// or churning structures (job progress/input/result/error, timeline
// segments/provenance, the edit-graph document, etc.) round-trip through jsonb
// columns.
//
// Two implementations share the V1Store interface:
//   * createSupabaseStore() — the production store, used by getStore(). Runs with
//     the service_role key (see ./supabase-client) and enforces tenancy in app
//     code; it never compares the auth id (golden rule: key on the domain id).
//   * createStore(rootDir)  — a file-based store kept for offline unit tests that
//     spin up a temp dir; semantics match the Supabase store byte-for-byte from
//     the caller's perspective.

export interface IdempotencyRecord {
  requestHash: string;
  jobId: string;
  createdAt: string;
}

export interface V1Store {
  // Reads consumed by PR4.
  getProject(id: string): Promise<V1Project | null>;
  getBriefVersion(id: string): Promise<BriefVersion | null>;
  getAsset(id: string): Promise<V1Asset | null>;
  listAssets(projectId: string): Promise<V1Asset[]>;
  getComposition(id: string): Promise<CompositionPlan | null>;

  // Writes owned by PR4.
  getJob(id: string): Promise<Job | null>;
  saveJob(job: Job): Promise<Job>;
  getEditGraph(id: string): Promise<VersionedEditGraph | null>;
  saveEditGraph(graph: VersionedEditGraph): Promise<VersionedEditGraph>;
  getTimeline(id: string): Promise<VersionedTimeline | null>;
  saveTimeline(timeline: VersionedTimeline): Promise<VersionedTimeline>;
  getIdempotency(scope: string): Promise<IdempotencyRecord | null>;
  saveIdempotency(scope: string, record: IdempotencyRecord): Promise<void>;

  // Seed writers — represent records the PR1-PR3 foundation creates.
  saveProject(project: V1Project): Promise<V1Project>;
  saveBriefVersion(brief: BriefVersion): Promise<BriefVersion>;
  saveAsset(asset: V1Asset): Promise<V1Asset>;
  saveComposition(composition: CompositionPlan): Promise<CompositionPlan>;
}

// ---------------------------------------------------------------------------
// Supabase (Postgres) implementation
// ---------------------------------------------------------------------------

// The lib/v1 store keys idempotency by scope alone and stores key = '' (the
// column default), matching the file-based behaviour where the scope was the
// filename. The composite (scope, key) primary key in the schema is a superset
// shared with the api/v1 foundation store.
const IDEMPOTENCY_KEY = "";

// PostgREST "row not found" code from .single(); treated as a null read.
const PGRST_NO_ROWS = "PGRST116";

function isMissing(error: { code?: string } | null): boolean {
  return !!error && error.code === PGRST_NO_ROWS;
}

function fail(op: string, error: { message?: string } | null): never {
  throw new Error(`v1 store: ${op} failed: ${error?.message ?? "unknown error"}`);
}

// --- row <-> object mappers ------------------------------------------------

interface ProjectRow {
  id: string;
  schema_version: string;
  workspace_id: string;
  name: string;
  status: V1Project["status"];
  created_at: string;
  updated_at: string;
}

function rowToProject(r: ProjectRow): V1Project {
  return {
    id: r.id,
    schemaVersion: r.schema_version as V1Project["schemaVersion"],
    workspaceId: r.workspace_id,
    name: r.name,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

interface BriefVersionRow {
  id: string;
  schema_version: string;
  project_id: string;
  brief: BriefVersion["brief"];
  created_at: string;
}

function rowToBriefVersion(r: BriefVersionRow): BriefVersion {
  return {
    id: r.id,
    schemaVersion: r.schema_version as BriefVersion["schemaVersion"],
    projectId: r.project_id,
    brief: r.brief,
    createdAt: r.created_at,
  };
}

interface AssetRow {
  id: string;
  schema_version: string;
  workspace_id: string;
  project_id: string;
  kind: V1Asset["kind"];
  status: V1Asset["status"];
  filename: string;
  url: string | null;
  remote_url: string | null;
  storage_key: string | null;
  duration_sec: number | null;
  description: string | null;
  context: { userContext?: V1Asset["userContext"]; agentContext?: V1Asset["agentContext"] } | null;
  semantic_analysis: {
    assetKnowledge?: V1Asset["assetKnowledge"];
    clipUnderstanding?: V1Asset["clipUnderstanding"];
  } | null;
  source: unknown;
  generated_asset_job_id: string | null;
  created_at: string;
  updated_at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function rowSourceToV1Source(source: unknown): V1Asset["source"] {
  if (
    source === "upload" ||
    source === "remote_url" ||
    source === "local_path" ||
    source === "generated"
  ) {
    return source;
  }
  if (!isRecord(source)) return "upload";
  switch (source.type) {
    case "remote_url":
      return "remote_url";
    case "local_path":
      return "local_path";
    case "generated":
      return "generated";
    case "multipart_upload":
      return "upload";
    default:
      return "upload";
  }
}

export function renderableAssetUrlFromRow(
  row: Pick<AssetRow, "url" | "remote_url" | "storage_key" | "source">
): string {
  if (row.url) return row.url;
  if (
    isRecord(row.source) &&
    row.source.type === "remote_url" &&
    typeof row.source.url === "string"
  ) {
    return row.source.url;
  }
  if (row.remote_url) return row.remote_url;
  return row.storage_key ?? "";
}

function rowToAsset(r: AssetRow): V1Asset {
  const asset: V1Asset = {
    id: r.id,
    schemaVersion: r.schema_version as V1Asset["schemaVersion"],
    projectId: r.project_id,
    workspaceId: r.workspace_id,
    kind: r.kind,
    status: r.status,
    filename: r.filename,
    url: renderableAssetUrlFromRow(r),
    durationSec: r.duration_sec ?? 0,
    source: rowSourceToV1Source(r.source),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (r.description != null) asset.description = r.description;
  if (r.context?.userContext) asset.userContext = r.context.userContext;
  if (r.context?.agentContext) asset.agentContext = r.context.agentContext;
  if (r.semantic_analysis?.assetKnowledge)
    asset.assetKnowledge = r.semantic_analysis.assetKnowledge;
  if (r.semantic_analysis?.clipUnderstanding)
    asset.clipUnderstanding = r.semantic_analysis.clipUnderstanding;
  if (r.generated_asset_job_id != null)
    asset.generatedAssetJobId = r.generated_asset_job_id;
  return asset;
}

function assetToRow(a: V1Asset): AssetRow {
  const context: AssetRow["context"] = {};
  if (a.userContext) context.userContext = a.userContext;
  if (a.agentContext) context.agentContext = a.agentContext;
  const semantic: AssetRow["semantic_analysis"] = {};
  if (a.assetKnowledge) semantic.assetKnowledge = a.assetKnowledge;
  if (a.clipUnderstanding) semantic.clipUnderstanding = a.clipUnderstanding;
  return {
    id: a.id,
    schema_version: a.schemaVersion,
    workspace_id: a.workspaceId,
    project_id: a.projectId,
    kind: a.kind,
    status: a.status,
    filename: a.filename,
    url: a.url ?? null,
    remote_url: a.source === "remote_url" ? a.url : null,
    storage_key: null,
    duration_sec: a.durationSec ?? null,
    description: a.description ?? null,
    context: Object.keys(context).length ? context : null,
    semantic_analysis: Object.keys(semantic).length ? semantic : null,
    source: a.source,
    generated_asset_job_id: a.generatedAssetJobId ?? null,
    created_at: a.createdAt,
    updated_at: a.updatedAt,
  };
}

interface CompositionRow {
  id: string;
  schema_version: string;
  project_id: string;
  brief_version_id: string | null;
  mode: CompositionPlan["mode"];
  status: CompositionPlan["status"];
  planned_beats: CompositionPlan["plannedBeats"];
  generated_asset_job_ids: string[];
  ready_asset_ids: string[];
  narration_strategy: CompositionPlan["narrationStrategy"] | null;
  created_at: string;
  updated_at: string;
}

function rowToComposition(r: CompositionRow): CompositionPlan {
  const plan: CompositionPlan = {
    id: r.id,
    schemaVersion: r.schema_version as CompositionPlan["schemaVersion"],
    projectId: r.project_id,
    briefVersionId: r.brief_version_id ?? "",
    mode: r.mode,
    status: r.status,
    plannedBeats: r.planned_beats ?? [],
    generatedAssetJobIds: r.generated_asset_job_ids ?? [],
    readyAssetIds: r.ready_asset_ids ?? [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (r.narration_strategy) plan.narrationStrategy = r.narration_strategy;
  return plan;
}

function compositionToRow(c: CompositionPlan): CompositionRow {
  return {
    id: c.id,
    schema_version: c.schemaVersion,
    project_id: c.projectId,
    brief_version_id: c.briefVersionId || null,
    mode: c.mode,
    status: c.status,
    planned_beats: c.plannedBeats ?? [],
    generated_asset_job_ids: c.generatedAssetJobIds ?? [],
    ready_asset_ids: c.readyAssetIds ?? [],
    narration_strategy: c.narrationStrategy ?? null,
    created_at: c.createdAt,
    updated_at: c.updatedAt,
  };
}

interface JobRow {
  id: string;
  schema_version: string;
  workspace_id: string;
  project_id: string;
  request_id: string | null;
  type: Job["type"];
  status: Job["status"];
  progress: Job["progress"];
  input: Job["input"];
  result: Job["result"];
  error: Job["error"];
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
}

function rowToJob(r: JobRow): Job {
  const job: Job = {
    id: r.id,
    schemaVersion: r.schema_version as Job["schemaVersion"],
    workspaceId: r.workspace_id,
    projectId: r.project_id,
    type: r.type,
    status: r.status,
    progress: r.progress ?? {},
    input: r.input ?? null,
    result: r.result ?? null,
    error: r.error ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (r.request_id != null) job.requestId = r.request_id;
  if (r.idempotency_key != null) job.idempotencyKey = r.idempotency_key;
  return job;
}

function jobToRow(j: Job): JobRow {
  return {
    id: j.id,
    schema_version: j.schemaVersion,
    workspace_id: j.workspaceId,
    project_id: j.projectId,
    request_id: j.requestId ?? null,
    type: j.type,
    status: j.status,
    progress: j.progress ?? {},
    input: j.input ?? null,
    result: j.result ?? null,
    error: j.error ?? null,
    idempotency_key: j.idempotencyKey ?? null,
    created_at: j.createdAt,
    updated_at: j.updatedAt,
  };
}

interface EditGraphRow {
  id: string;
  schema_version: string;
  project_id: string;
  brief_version_id: string | null;
  composition_id: string | null;
  document: VersionedEditGraph;
  created_at: string;
  updated_at: string;
}

function rowToEditGraph(r: EditGraphRow): VersionedEditGraph {
  // The full EditGraphDocument is stored in `document`; the relational columns
  // are extracted copies for FK integrity and indexing. The document is the
  // source of truth on read, EXCEPT its top-level `id`: that is the DB-generated
  // row id (the document's internal node ids are seeded from its own in-JSON id,
  // which is exempt and may differ from the row id).
  return { ...r.document, id: r.id };
}

function editGraphToRow(g: VersionedEditGraph): EditGraphRow {
  return {
    id: g.id,
    schema_version: g.schemaVersion,
    project_id: g.projectId,
    brief_version_id: g.briefVersionId || null,
    composition_id: g.compositionId ?? null,
    document: g,
    created_at: g.createdAt,
    updated_at: g.updatedAt,
  };
}

interface TimelineRow {
  id: string;
  schema_version: string;
  project_id: string;
  brief_version_id: string | null;
  composition_id: string | null;
  aspect_ratio: string;
  fps: number;
  show_captions: boolean | null;
  segments: VersionedTimeline["segments"];
  provenance: VersionedTimeline["provenance"];
  derived_from: VersionedTimeline["derivedFrom"] | null;
  created_by: VersionedTimeline["createdBy"];
  created_at: string;
}

function rowToTimeline(r: TimelineRow): VersionedTimeline {
  const timeline: VersionedTimeline = {
    id: r.id,
    schemaVersion: r.schema_version as VersionedTimeline["schemaVersion"],
    projectId: r.project_id,
    briefVersionId: r.brief_version_id ?? "",
    aspectRatio: r.aspect_ratio as VersionedTimeline["aspectRatio"],
    fps: r.fps,
    segments: r.segments ?? [],
    provenance: r.provenance,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
  if (r.composition_id != null) timeline.compositionId = r.composition_id;
  if (r.show_captions != null) timeline.showCaptions = r.show_captions;
  if (r.derived_from != null) timeline.derivedFrom = r.derived_from;
  return timeline;
}

function timelineToRow(t: VersionedTimeline): TimelineRow {
  return {
    id: t.id,
    schema_version: t.schemaVersion,
    project_id: t.projectId,
    brief_version_id: t.briefVersionId || null,
    composition_id: t.compositionId ?? null,
    aspect_ratio: t.aspectRatio,
    fps: t.fps,
    show_captions: t.showCaptions ?? null,
    segments: t.segments ?? [],
    provenance: t.provenance,
    derived_from: t.derivedFrom ?? null,
    created_by: t.createdBy,
    created_at: t.createdAt,
  };
}

export function createSupabaseStore(
  db: SupabaseClient = getServiceSupabase()
): V1Store {
  async function getOne<Row>(
    table: string,
    column: string,
    value: string
  ): Promise<Row | null> {
    const { data, error } = await db
      .from(table)
      .select("*")
      .eq(column, value)
      .single();
    if (error) {
      if (isMissing(error)) return null;
      fail(`get ${table}`, error);
    }
    return (data as Row) ?? null;
  }

  async function upsert<Row extends object>(
    table: string,
    row: Row,
    conflict: string
  ): Promise<void> {
    const { error } = await db
      .from(table)
      .upsert(row as Record<string, unknown>, { onConflict: conflict });
    if (error) fail(`save ${table}`, error);
  }

  // Create-or-update keyed on the DB-generated id. When the entity has no id yet
  // (first save), INSERT omitting `id` so Postgres assigns it (gen_random_uuid)
  // and read the generated id back. When it already has an id (subsequent save
  // = update), upsert by id. Returns the id that was persisted.
  async function saveWithGeneratedId<Row extends { id: string }>(
    table: string,
    row: Row
  ): Promise<string> {
    if (row.id) {
      await upsert(table, row, "id");
      return row.id;
    }
    const { id: _omit, ...insertable } = row;
    void _omit;
    const { data, error } = await db
      .from(table)
      .insert(insertable as Record<string, unknown>)
      .select("id")
      .single();
    if (error) fail(`save ${table}`, error);
    return (data as { id: string }).id;
  }

  return {
    async getProject(id) {
      const row = await getOne<ProjectRow>("projects", "id", id);
      return row ? rowToProject(row) : null;
    },
    async getBriefVersion(id) {
      const row = await getOne<BriefVersionRow>("brief_versions", "id", id);
      return row ? rowToBriefVersion(row) : null;
    },
    async getAsset(id) {
      const row = await getOne<AssetRow>("assets", "id", id);
      return row ? rowToAsset(row) : null;
    },
    async listAssets(projectId) {
      const { data, error } = await db
        .from("assets")
        .select("*")
        .eq("project_id", projectId);
      if (error) fail("list assets", error);
      return ((data as AssetRow[]) ?? []).map(rowToAsset);
    },
    async getComposition(id) {
      const row = await getOne<CompositionRow>("compositions", "id", id);
      return row ? rowToComposition(row) : null;
    },

    async getJob(id) {
      const row = await getOne<JobRow>("jobs", "id", id);
      return row ? rowToJob(row) : null;
    },
    async saveJob(job) {
      const id = await saveWithGeneratedId("jobs", jobToRow(job));
      return { ...job, id };
    },
    async getEditGraph(id) {
      const row = await getOne<EditGraphRow>("edit_graphs", "id", id);
      return row ? rowToEditGraph(row) : null;
    },
    async saveEditGraph(graph) {
      const id = await saveWithGeneratedId("edit_graphs", editGraphToRow(graph));
      return { ...graph, id };
    },
    async getTimeline(id) {
      const row = await getOne<TimelineRow>("timelines", "id", id);
      return row ? rowToTimeline(row) : null;
    },
    async saveTimeline(timeline) {
      const id = await saveWithGeneratedId("timelines", timelineToRow(timeline));
      return { ...timeline, id };
    },
    async getIdempotency(scope) {
      const { data, error } = await db
        .from("idempotency")
        .select("*")
        .eq("scope", scope)
        .eq("key", IDEMPOTENCY_KEY)
        .single();
      if (error) {
        if (isMissing(error)) return null;
        fail("get idempotency", error);
      }
      const row = data as {
        request_hash: string | null;
        job_id: string | null;
        created_at: string;
      } | null;
      if (!row) return null;
      return {
        requestHash: row.request_hash ?? "",
        jobId: row.job_id ?? "",
        createdAt: row.created_at,
      };
    },
    async saveIdempotency(scope, record) {
      const { error } = await db.from("idempotency").upsert(
        {
          scope,
          key: IDEMPOTENCY_KEY,
          request_hash: record.requestHash,
          job_id: record.jobId,
          created_at: record.createdAt,
        },
        { onConflict: "scope,key" }
      );
      if (error) fail("save idempotency", error);
    },

    async saveProject(project) {
      // The owning workspace already exists (find-or-create in auth resolution);
      // its uuid is project.workspaceId, so the FK holds without seeding one here.
      const id = await saveWithGeneratedId("projects", {
        id: project.id,
        schema_version: project.schemaVersion,
        workspace_id: project.workspaceId,
        name: project.name,
        status: project.status,
        created_at: project.createdAt,
        updated_at: project.updatedAt,
      });
      return { ...project, id };
    },
    async saveBriefVersion(brief) {
      const id = await saveWithGeneratedId("brief_versions", {
        id: brief.id,
        schema_version: brief.schemaVersion,
        project_id: brief.projectId,
        brief: brief.brief,
        created_at: brief.createdAt,
      });
      return { ...brief, id };
    },
    async saveAsset(asset) {
      const id = await saveWithGeneratedId("assets", assetToRow(asset));
      return { ...asset, id };
    },
    async saveComposition(composition) {
      const id = await saveWithGeneratedId("compositions", compositionToRow(composition));
      return { ...composition, id };
    },
  };
}

// ---------------------------------------------------------------------------
// File-based implementation (offline unit tests)
// ---------------------------------------------------------------------------

const COLLECTIONS = {
  projects: "projects",
  briefVersions: "brief-versions",
  assets: "assets",
  compositions: "compositions",
  editGraphs: "edit-graphs",
  jobs: "jobs",
  timelines: "timelines",
  idempotency: "idempotency",
} as const;

function safeKey(key: string): string {
  // Records are keyed by generated IDs / hashes, but guard against traversal.
  return key.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

export function createStore(rootDir: string): V1Store {
  function dir(collection: string): string {
    return path.join(rootDir, collection);
  }

  function file(collection: string, key: string): string {
    return path.join(dir(collection), `${safeKey(key)}.json`);
  }

  async function readJson<T>(collection: string, key: string): Promise<T | null> {
    try {
      const raw = await fs.readFile(file(collection, key), "utf8");
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async function writeJson<T>(collection: string, key: string, value: T): Promise<T> {
    await fs.mkdir(dir(collection), { recursive: true });
    await fs.writeFile(file(collection, key), JSON.stringify(value, null, 2), "utf8");
    return value;
  }

  async function readAll<T>(collection: string): Promise<T[]> {
    let names: string[];
    try {
      names = await fs.readdir(dir(collection));
    } catch {
      return [];
    }
    const records: T[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(dir(collection), name), "utf8");
        records.push(JSON.parse(raw) as T);
      } catch {
        // Skip unreadable/partial records rather than failing the whole list.
      }
    }
    return records;
  }

  // Mirror the Postgres "DB assigns the id" contract in the file store: when an
  // entity is saved without an id (first save), assign a uuid (the DB stand-in)
  // and key the file by it; subsequent saves carry the assigned id.
  function saveWithId<T extends { id: string }>(
    collection: string,
    entity: T
  ): Promise<T> {
    const withId = entity.id ? entity : { ...entity, id: randomUUID() };
    return writeJson(collection, withId.id, withId);
  }

  return {
    getProject: (id) => readJson<V1Project>(COLLECTIONS.projects, id),
    getBriefVersion: (id) => readJson<BriefVersion>(COLLECTIONS.briefVersions, id),
    getAsset: (id) => readJson<V1Asset>(COLLECTIONS.assets, id),
    async listAssets(projectId) {
      const all = await readAll<V1Asset>(COLLECTIONS.assets);
      return all.filter((a) => a.projectId === projectId);
    },
    getComposition: (id) => readJson<CompositionPlan>(COLLECTIONS.compositions, id),

    getJob: (id) => readJson<Job>(COLLECTIONS.jobs, id),
    saveJob: (job) => saveWithId(COLLECTIONS.jobs, job),
    getEditGraph: (id) => readJson<VersionedEditGraph>(COLLECTIONS.editGraphs, id),
    saveEditGraph: (graph) => saveWithId(COLLECTIONS.editGraphs, graph),
    getTimeline: (id) => readJson<VersionedTimeline>(COLLECTIONS.timelines, id),
    saveTimeline: (timeline) => saveWithId(COLLECTIONS.timelines, timeline),
    getIdempotency: (scope) => readJson<IdempotencyRecord>(COLLECTIONS.idempotency, scope),
    async saveIdempotency(scope, record) {
      await writeJson(COLLECTIONS.idempotency, scope, record);
    },

    saveProject: (project) => saveWithId(COLLECTIONS.projects, project),
    saveBriefVersion: (brief) => saveWithId(COLLECTIONS.briefVersions, brief),
    saveAsset: (asset) => saveWithId(COLLECTIONS.assets, asset),
    saveComposition: (composition) => saveWithId(COLLECTIONS.compositions, composition),
  };
}

export function defaultDbDir(): string {
  return (
    process.env.POPCORN_READY_DEV_DB_DIR || path.join(process.cwd(), ".local", "dev-db")
  );
}

let _store: V1Store | null = null;
export function getStore(): V1Store {
  // Production singleton: Postgres-backed via the service-role client.
  if (!_store) _store = createSupabaseStore();
  return _store;
}

// Test hook so a suite can inject a deterministic store (e.g. a file-based one
// from createStore(tmpDir), or a stubbed Supabase client via createSupabaseStore).
export function setStoreForTests(store: V1Store | null): void {
  _store = store;
}
