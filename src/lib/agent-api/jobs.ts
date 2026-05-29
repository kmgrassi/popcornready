// JSON-backed store for /api/v1 jobs and artifacts.
//
// MVP persistence mirroring src/lib/store.ts: a single JSON file under data/.
// TODO: replace with a real database and a background queue. Workers run inline
// today, so a job is already terminal by the time a POST returns; the GET
// endpoints still exist so agents can poll exactly as they will against a real
// async queue.

import { promises as fs } from "fs";
import path from "path";
import { newId } from "./runtime";
import {
  ApiErrorBody,
  Artifact,
  Job,
  JobStatus,
  JobStep,
  JobType,
} from "./types";

interface StoreShape {
  jobs: Job[];
  artifacts: Artifact[];
  // `${type}:${idempotencyKey}` -> jobId. TODO(PR1): scope by workspaceId once
  // multiple workspaces exist.
  idempotency: Record<string, string>;
}

function emptyStore(): StoreShape {
  return { jobs: [], artifacts: [], idempotency: {} };
}

export class AgentApiStore {
  private file: string;
  private dir: string;

  constructor(baseDir: string) {
    this.dir = baseDir;
    this.file = path.join(baseDir, "agent-jobs.json");
  }

  private async read(): Promise<StoreShape> {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      return { ...emptyStore(), ...(JSON.parse(raw) as StoreShape) };
    } catch {
      return emptyStore();
    }
  }

  private async write(state: StoreShape): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(state, null, 2), "utf8");
  }

  async getJob(id: string): Promise<Job | null> {
    const state = await this.read();
    return state.jobs.find((j) => j.id === id) ?? null;
  }

  // Create a queued job, or return the existing job for a repeated
  // idempotency key so retried mutating requests don't create duplicates.
  async createOrGetJob(input: {
    type: JobType;
    projectId: string;
    idempotencyKey?: string | null;
  }): Promise<{ job: Job; created: boolean }> {
    const state = await this.read();

    if (input.idempotencyKey) {
      const key = `${input.type}:${input.idempotencyKey}`;
      const existingId = state.idempotency[key];
      const existing = existingId
        ? state.jobs.find((j) => j.id === existingId)
        : undefined;
      if (existing) return { job: existing, created: false };
    }

    const now = new Date().toISOString();
    const job: Job = {
      id: newId("job"),
      type: input.type,
      status: "queued",
      projectId: input.projectId,
      idempotencyKey: input.idempotencyKey ?? undefined,
      createdAt: now,
      updatedAt: now,
    };
    state.jobs.push(job);
    if (input.idempotencyKey) {
      state.idempotency[`${input.type}:${input.idempotencyKey}`] = job.id;
    }
    await this.write(state);
    return { job, created: true };
  }

  private async patchJob(id: string, patch: Partial<Job>): Promise<Job> {
    const state = await this.read();
    const job = state.jobs.find((j) => j.id === id);
    if (!job) throw new Error(`Job not found: ${id}`);
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    await this.write(state);
    return job;
  }

  async setStep(id: string, step: JobStep): Promise<Job> {
    return this.patchJob(id, { status: "running", step });
  }

  async succeed<T>(id: string, result: T): Promise<Job<T>> {
    return (await this.patchJob(id, {
      status: "succeeded" as JobStatus,
      result,
    })) as Job<T>;
  }

  async fail(id: string, error: ApiErrorBody): Promise<Job> {
    return this.patchJob(id, { status: "failed", error });
  }

  async saveArtifact(artifact: Artifact): Promise<Artifact> {
    const state = await this.read();
    state.artifacts.push(artifact);
    await this.write(state);
    return artifact;
  }

  async getArtifact(id: string): Promise<Artifact | null> {
    const state = await this.read();
    return state.artifacts.find((a) => a.id === id) ?? null;
  }
}

// Default store used by the route handlers. Tests construct their own store
// pointed at a temp dir so they never touch the project's data/ directory.
export const agentApiStore = new AgentApiStore(
  path.join(process.cwd(), "data")
);
