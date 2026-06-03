// PR2: job persistence for the PR1 agent-API stack.
//
// The PR1 store (store.ts) does not yet model jobs, and the parallel generations
// stack (src/lib/v1) keeps its own job store. To keep generated assets pollable
// through the same workspace/store the assets live in, jobs are persisted here in
// a sibling JSON file under the same `.local/` dir. Swap for the shared store /
// Postgres when the v1 stacks are unified.

import { promises as fs } from "fs";
import path from "path";
import { newId } from "./ids";
import { localDir } from "./store";

export const JOB_SCHEMA_VERSION = "job.v1" as const;

export type JobType =
  | "asset_ingest"
  | "asset_generation"
  | "composition"
  | "timeline_generation"
  | "audio_alignment"
  | "revision"
  | "export";

export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

export interface JobProgress {
  currentStep?: string;
  percent?: number;
}

export interface V1Job {
  id: string;
  schemaVersion: typeof JOB_SCHEMA_VERSION;
  workspaceId: string;
  projectId: string;
  type: JobType;
  status: JobStatus;
  progress?: JobProgress;
  result?: unknown;
  error?: { code: string; message: string } | null;
  createdAt: string;
  updatedAt: string;
}

interface JobsDb {
  jobs: V1Job[];
}

function jobsFile(): string {
  return path.join(localDir(), "agent-jobs.json");
}

async function readDb(): Promise<JobsDb> {
  try {
    const raw = await fs.readFile(jobsFile(), "utf8");
    return { jobs: [], ...(JSON.parse(raw) as Partial<JobsDb>) } as JobsDb;
  } catch {
    return { jobs: [] };
  }
}

async function writeDb(db: JobsDb): Promise<void> {
  await fs.mkdir(localDir(), { recursive: true });
  await fs.writeFile(jobsFile(), JSON.stringify(db, null, 2), "utf8");
}

// Serialize read-modify-write so concurrent retries cannot corrupt the file.
let writeChain: Promise<unknown> = Promise.resolve();

function mutate<T>(fn: (db: JobsDb) => T | Promise<T>): Promise<T> {
  const run = writeChain.then(async () => {
    const db = await readDb();
    const result = await fn(db);
    await writeDb(db);
    return result;
  });
  writeChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export function createJob(
  input: Omit<V1Job, "id" | "schemaVersion" | "createdAt" | "updatedAt">
): Promise<V1Job> {
  return mutate((db) => {
    const now = new Date().toISOString();
    const job: V1Job = {
      ...input,
      id: newId("job"),
      schemaVersion: JOB_SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
    };
    db.jobs.push(job);
    return job;
  });
}

export function updateJob(
  jobId: string,
  patch: Partial<Omit<V1Job, "id" | "schemaVersion" | "createdAt">>
): Promise<V1Job> {
  return mutate((db) => {
    const job = db.jobs.find((j) => j.id === jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    return job;
  });
}

export async function getJob(jobId: string): Promise<V1Job | null> {
  const db = await readDb();
  return db.jobs.find((j) => j.id === jobId) || null;
}
