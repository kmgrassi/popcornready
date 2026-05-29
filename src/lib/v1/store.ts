import { promises as fs } from "fs";
import path from "path";
import {
  BriefVersion,
  CompositionPlan,
  Job,
  V1Asset,
  V1Project,
  VersionedTimeline,
} from "./types";

// Local development repository for /api/v1.
//
// V1 persists JSON records under `.local/dev-db/` (per the jobs + storage
// scopes). The PR1-PR3 foundation owns writing projects, brief versions,
// assets, and compositions; PR4 reads those and writes jobs + timelines. The
// seed writers exist so this PR is runnable/testable end-to-end before the
// other PRs land — they represent the records those PRs would create. Swapping
// to Postgres later only changes this module, not the route/business logic.

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

const COLLECTIONS = {
  projects: "projects",
  briefVersions: "brief-versions",
  assets: "assets",
  compositions: "compositions",
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
    saveJob: (job) => writeJson(COLLECTIONS.jobs, job.id, job),
    getTimeline: (id) => readJson<VersionedTimeline>(COLLECTIONS.timelines, id),
    saveTimeline: (timeline) => writeJson(COLLECTIONS.timelines, timeline.id, timeline),
    getIdempotency: (scope) => readJson<IdempotencyRecord>(COLLECTIONS.idempotency, scope),
    async saveIdempotency(scope, record) {
      await writeJson(COLLECTIONS.idempotency, scope, record);
    },

    saveProject: (project) => writeJson(COLLECTIONS.projects, project.id, project),
    saveBriefVersion: (brief) => writeJson(COLLECTIONS.briefVersions, brief.id, brief),
    saveAsset: (asset) => writeJson(COLLECTIONS.assets, asset.id, asset),
    saveComposition: (composition) =>
      writeJson(COLLECTIONS.compositions, composition.id, composition),
  };
}

export function defaultDbDir(): string {
  return (
    process.env.AIVIDI_DEV_DB_DIR || path.join(process.cwd(), ".local", "dev-db")
  );
}

let _store: V1Store | null = null;
export function getStore(): V1Store {
  if (!_store) _store = createStore(defaultDbDir());
  return _store;
}
