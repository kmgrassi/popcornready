// Persistence for the versioned agent API.
//
// This is a separate store from the single-project browser store (src/lib/store.ts).
// The agent API is multi-project and multi-workspace, and the v1 contract persists
// agent data under `.local/`. Swap the JSON file for Postgres later without changing
// the function signatures below.

import { promises as fs } from "fs";
import path from "path";
import { notFound } from "./errors";
import { newId } from "./ids";
import { GeneratedAssetProvenance } from "./provenance";
import {
  AgentAssetSource,
  AssetContext,
  AssetKind,
  SCHEMA_VERSIONS,
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
  remoteUrl?: string;
  storageKey?: string;
  durationSec?: number;
  context?: AssetContext;
  // Present for assets produced by the generated-assets endpoint (PR2).
  provenance?: GeneratedAssetProvenance;
  createdAt: string;
  updatedAt: string;
}

export interface IdempotencyRecord {
  scope: string;
  key: string;
  bodyHash: string;
  status: number;
  responseBody: unknown;
  createdAt: string;
}

interface V1Db {
  schemaVersion: string;
  workspaces: V1Workspace[];
  projects: V1Project[];
  briefVersions: V1BriefVersion[];
  assets: V1Asset[];
  idempotency: IdempotencyRecord[];
}

const DB_SCHEMA_VERSION = "agentDb.v1";

// Resolved per call so tests can point POPCORN_READY_LOCAL_DIR at a temp directory.
export function localDir(): string {
  return process.env.POPCORN_READY_LOCAL_DIR || path.join(process.cwd(), ".local");
}

function dbFile(): string {
  return path.join(localDir(), "agent-store.json");
}

export function mediaUploadDir(workspaceId: string, projectId: string): string {
  return path.join(localDir(), "media", "uploads", workspaceId, projectId);
}

export function mediaGeneratedDir(workspaceId: string, projectId: string): string {
  return path.join(localDir(), "media", "generated", workspaceId, projectId);
}

function emptyDb(): V1Db {
  return {
    schemaVersion: DB_SCHEMA_VERSION,
    workspaces: [],
    projects: [],
    briefVersions: [],
    assets: [],
    idempotency: [],
  };
}

async function readDb(): Promise<V1Db> {
  try {
    const raw = await fs.readFile(dbFile(), "utf8");
    const parsed = JSON.parse(raw) as Partial<V1Db>;
    return { ...emptyDb(), ...parsed } as V1Db;
  } catch {
    return emptyDb();
  }
}

async function writeDb(db: V1Db): Promise<void> {
  await fs.mkdir(localDir(), { recursive: true });
  await fs.writeFile(dbFile(), JSON.stringify(db, null, 2), "utf8");
}

// Serialize read-modify-write cycles so concurrent agent retries (idempotency,
// asset registration) cannot interleave and corrupt the JSON file.
let writeChain: Promise<unknown> = Promise.resolve();

function mutate<T>(fn: (db: V1Db) => T | Promise<T>): Promise<T> {
  const run = writeChain.then(async () => {
    const db = await readDb();
    const result = await fn(db);
    await writeDb(db);
    return result;
  });
  // Keep the chain alive even if this mutation rejects.
  writeChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export interface PageResult<T> {
  items: T[];
  nextCursor: string | null;
}

// Newest-first cursor pagination keyed on stable record IDs.
function paginate<T extends { id: string; createdAt: string }>(
  all: T[],
  limit: number,
  cursor: string | null
): PageResult<T> {
  const sorted = [...all].sort((a, b) => {
    if (a.createdAt === b.createdAt) return a.id < b.id ? 1 : -1;
    return a.createdAt < b.createdAt ? 1 : -1;
  });
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

export async function ensureWorkspace(id: string, name: string): Promise<V1Workspace> {
  return mutate((db) => {
    let ws = db.workspaces.find((w) => w.id === id);
    if (!ws) {
      const now = new Date().toISOString();
      ws = {
        id,
        schemaVersion: SCHEMA_VERSIONS.workspace,
        name,
        createdAt: now,
        updatedAt: now,
      };
      db.workspaces.push(ws);
    }
    return ws;
  });
}

export async function createProject(input: {
  workspaceId: string;
  name: string;
  brief?: VideoBrief;
}): Promise<{ project: V1Project; briefVersion: V1BriefVersion | null }> {
  return mutate((db) => {
    const now = new Date().toISOString();
    const project: V1Project = {
      id: newId("proj"),
      schemaVersion: SCHEMA_VERSIONS.project,
      workspaceId: input.workspaceId,
      name: input.name,
      status: "active",
      brief: input.brief ?? null,
      currentBriefVersionId: null,
      createdAt: now,
      updatedAt: now,
    };
    let briefVersion: V1BriefVersion | null = null;
    if (input.brief) {
      briefVersion = {
        id: newId("briefv"),
        schemaVersion: SCHEMA_VERSIONS.briefVersion,
        projectId: project.id,
        brief: input.brief,
        createdAt: now,
      };
      project.currentBriefVersionId = briefVersion.id;
      db.briefVersions.push(briefVersion);
    }
    db.projects.push(project);
    return { project, briefVersion };
  });
}

export async function getProject(
  workspaceId: string,
  projectId: string
): Promise<V1Project> {
  const db = await readDb();
  const project = db.projects.find(
    (p) => p.id === projectId && p.workspaceId === workspaceId && p.status !== "deleted"
  );
  if (!project) throw notFound(`Project not found: ${projectId}`);
  return project;
}

export async function listProjects(
  workspaceId: string,
  limit: number,
  cursor: string | null
): Promise<PageResult<V1Project>> {
  const db = await readDb();
  const all = db.projects.filter(
    (p) => p.workspaceId === workspaceId && p.status !== "deleted"
  );
  return paginate(all, limit, cursor);
}

export async function setBrief(
  workspaceId: string,
  projectId: string,
  brief: VideoBrief
): Promise<V1Project> {
  return mutate((db) => {
    const project = db.projects.find(
      (p) => p.id === projectId && p.workspaceId === workspaceId && p.status !== "deleted"
    );
    if (!project) throw notFound(`Project not found: ${projectId}`);
    project.brief = brief;
    project.updatedAt = new Date().toISOString();
    return project;
  });
}

export async function createBriefVersion(
  workspaceId: string,
  projectId: string,
  brief: VideoBrief
): Promise<{ project: V1Project; briefVersion: V1BriefVersion }> {
  return mutate((db) => {
    const project = db.projects.find(
      (p) => p.id === projectId && p.workspaceId === workspaceId && p.status !== "deleted"
    );
    if (!project) throw notFound(`Project not found: ${projectId}`);
    const now = new Date().toISOString();
    const briefVersion: V1BriefVersion = {
      id: newId("briefv"),
      schemaVersion: SCHEMA_VERSIONS.briefVersion,
      projectId,
      brief,
      createdAt: now,
    };
    db.briefVersions.push(briefVersion);
    project.brief = brief;
    project.currentBriefVersionId = briefVersion.id;
    project.updatedAt = now;
    return { project, briefVersion };
  });
}

export async function listBriefVersions(
  workspaceId: string,
  projectId: string,
  limit: number,
  cursor: string | null
): Promise<PageResult<V1BriefVersion>> {
  await getProject(workspaceId, projectId);
  const db = await readDb();
  const all = db.briefVersions.filter((b) => b.projectId === projectId);
  return paginate(all, limit, cursor);
}

export async function addAsset(asset: V1Asset): Promise<V1Asset> {
  return mutate((db) => {
    db.assets.push(asset);
    return asset;
  });
}

export async function getAsset(
  workspaceId: string,
  projectId: string,
  assetId: string
): Promise<V1Asset> {
  const db = await readDb();
  const asset = db.assets.find(
    (a) => a.id === assetId && a.projectId === projectId && a.workspaceId === workspaceId
  );
  if (!asset) throw notFound(`Asset not found: ${assetId}`);
  return asset;
}

export async function listAssets(
  workspaceId: string,
  projectId: string,
  limit: number,
  cursor: string | null
): Promise<PageResult<V1Asset>> {
  await getProject(workspaceId, projectId);
  const db = await readDb();
  const all = db.assets.filter(
    (a) => a.projectId === projectId && a.workspaceId === workspaceId
  );
  return paginate(all, limit, cursor);
}

export async function findIdempotencyRecord(
  scope: string,
  key: string
): Promise<IdempotencyRecord | undefined> {
  const db = await readDb();
  return db.idempotency.find((r) => r.scope === scope && r.key === key);
}

export async function saveIdempotencyRecord(
  record: IdempotencyRecord
): Promise<void> {
  await mutate((db) => {
    if (!db.idempotency.some((r) => r.scope === record.scope && r.key === record.key)) {
      db.idempotency.push(record);
    }
  });
}
