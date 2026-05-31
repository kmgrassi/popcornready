// Local persistence for generation runs.
//
// V1 stores runs in a single JSON file alongside the existing local stores.
// The shape is storage-neutral so a later migration to Postgres or another
// backend does not need to change the API response shape.

import { promises as fs } from "fs";
import path from "path";
import {
  GenerationErrorSummary,
  GenerationRun,
  GenerationRunInputs,
  GenerationRunStatus,
  GenerationStage,
  GenerationStageType,
  RUN_STAGES,
} from "./types";

function localDir(): string {
  return process.env.AIVIDI_LOCAL_DIR || path.join(process.cwd(), ".local");
}

function runsFile(): string {
  return path.join(localDir(), "runs.json");
}

interface RunsDb {
  schemaVersion: string;
  runs: GenerationRun[];
}

const DB_SCHEMA_VERSION = "runsDb.v1";

function emptyDb(): RunsDb {
  return { schemaVersion: DB_SCHEMA_VERSION, runs: [] };
}

async function readDb(): Promise<RunsDb> {
  try {
    const raw = await fs.readFile(runsFile(), "utf8");
    const parsed = JSON.parse(raw) as Partial<RunsDb>;
    return { ...emptyDb(), ...parsed } as RunsDb;
  } catch {
    return emptyDb();
  }
}

async function writeDb(db: RunsDb): Promise<void> {
  await fs.mkdir(localDir(), { recursive: true });
  await fs.writeFile(runsFile(), JSON.stringify(db, null, 2), "utf8");
}

// Serialize read-modify-write so background progress updates and the polling
// reader cannot interleave and corrupt the JSON file.
let writeChain: Promise<unknown> = Promise.resolve();

function mutate<T>(fn: (db: RunsDb) => T | Promise<T>): Promise<T> {
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

function newId(prefix: string): string {
  return `${prefix}_` + Math.random().toString(36).slice(2, 10);
}

function buildInitialStages(runId: string): GenerationStage[] {
  return RUN_STAGES.map((entry, index) => ({
    stageId: `${runId}_${entry.type}`,
    runId,
    type: entry.type,
    label: entry.label,
    order: index,
    status: index === 0 ? "queued" : "queued",
    jobIds: [],
    artifactIds: [],
    items: [],
  }));
}

export async function createRun(input: {
  projectId: string;
  inputs: GenerationRunInputs;
}): Promise<GenerationRun> {
  return mutate((db) => {
    const now = new Date().toISOString();
    const runId = newId("run");
    const run: GenerationRun = {
      runId,
      projectId: input.projectId,
      status: "queued",
      currentStageType: "brief_intake",
      message: "Run queued",
      createdAt: now,
      updatedAt: now,
      inputs: input.inputs,
      stages: buildInitialStages(runId),
    };
    db.runs.push(run);
    return run;
  });
}

export async function getRun(
  projectId: string,
  runId: string
): Promise<GenerationRun | null> {
  const db = await readDb();
  return (
    db.runs.find((r) => r.runId === runId && r.projectId === projectId) || null
  );
}

export async function listRuns(projectId: string): Promise<GenerationRun[]> {
  const db = await readDb();
  return db.runs
    .filter((r) => r.projectId === projectId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

function updateRun(
  db: RunsDb,
  runId: string,
  apply: (run: GenerationRun) => void
): GenerationRun | null {
  const run = db.runs.find((r) => r.runId === runId);
  if (!run) return null;
  apply(run);
  run.updatedAt = new Date().toISOString();
  return run;
}

export async function markRunRunning(runId: string): Promise<void> {
  await mutate((db) => {
    updateRun(db, runId, (run) => {
      run.status = "running";
      run.startedAt = run.startedAt || new Date().toISOString();
    });
  });
}

export async function markRunSucceeded(runId: string): Promise<void> {
  await mutate((db) => {
    updateRun(db, runId, (run) => {
      run.status = "succeeded";
      run.currentStageType = "ready";
      run.progressPercent = 100;
      run.message = "Your video is ready.";
      run.completedAt = new Date().toISOString();
    });
  });
}

export async function markRunFailed(
  runId: string,
  error: GenerationErrorSummary
): Promise<void> {
  await mutate((db) => {
    updateRun(db, runId, (run) => {
      run.status = "failed";
      run.error = error;
      run.message = error.message;
      run.completedAt = new Date().toISOString();
    });
  });
}

export async function startStage(
  runId: string,
  type: GenerationStageType,
  message?: string
): Promise<void> {
  await mutate((db) => {
    updateRun(db, runId, (run) => {
      const stage = run.stages.find((s) => s.type === type);
      if (!stage) return;
      stage.status = "running";
      stage.startedAt = stage.startedAt || new Date().toISOString();
      if (message) stage.message = message;
      run.currentStageType = type;
      if (message) run.message = message;
      const total = run.stages.length;
      run.progressPercent = Math.round((stage.order / total) * 100);
    });
  });
}

export async function completeStage(
  runId: string,
  type: GenerationStageType,
  message?: string
): Promise<void> {
  await mutate((db) => {
    updateRun(db, runId, (run) => {
      const stage = run.stages.find((s) => s.type === type);
      if (!stage) return;
      stage.status = "succeeded";
      stage.completedAt = new Date().toISOString();
      stage.progressPercent = 100;
      if (message) stage.message = message;
      const total = run.stages.length;
      run.progressPercent = Math.round(((stage.order + 1) / total) * 100);
    });
  });
}

export async function failStage(
  runId: string,
  type: GenerationStageType,
  error: GenerationErrorSummary
): Promise<void> {
  await mutate((db) => {
    updateRun(db, runId, (run) => {
      const stage = run.stages.find((s) => s.type === type);
      if (!stage) return;
      stage.status = "failed";
      stage.completedAt = new Date().toISOString();
      stage.error = error;
    });
  });
}

export async function setStageMessage(
  runId: string,
  type: GenerationStageType,
  message: string,
  progressPercent?: number
): Promise<void> {
  await mutate((db) => {
    updateRun(db, runId, (run) => {
      const stage = run.stages.find((s) => s.type === type);
      if (!stage) return;
      stage.message = message;
      if (typeof progressPercent === "number") {
        stage.progressPercent = progressPercent;
      }
      if (run.currentStageType === type) run.message = message;
    });
  });
}

// Exported for tests; production code should not need this.
export async function _resetForTests(): Promise<void> {
  await mutate((db) => {
    db.runs = [];
  });
}

export function _statusIsTerminal(status: GenerationRunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}
