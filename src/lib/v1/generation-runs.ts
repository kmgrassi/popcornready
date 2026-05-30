import { promises as fs } from "fs";
import path from "path";

import { defaultDbDir } from "./store";
import {
  GENERATION_STAGE_LABELS,
  GenerationRun,
  GenerationRunStatus,
  GenerationStage,
  GenerationStageItem,
  GenerationStageType,
} from "./types";
import { ApiError } from "./errors";

// Local persistence for generation runs, stages, and stage items.
//
// Records live under `.local/dev-db/` following the JSON-per-record convention
// used by `store.ts`. The shapes here intentionally match the endpoint wire
// response.

// --- Input/patch types -----------------------------------------------------

export type CreateGenerationRunInput = Omit<
  GenerationRun,
  "runId" | "createdAt" | "updatedAt"
> & { runId?: string };

export type CreateGenerationStageInput = Omit<
  GenerationStage,
  "stageId" | "createdAt" | "updatedAt"
> & { stageId?: string };

export type CreateGenerationStageItemInput = Omit<
  GenerationStageItem,
  "itemId" | "createdAt" | "updatedAt"
> & { itemId?: string };

export type UpdateGenerationRunPatch = Partial<
  Omit<GenerationRun, "runId" | "projectId" | "createdAt">
>;

export type UpdateGenerationStagePatch = Partial<
  Omit<GenerationStage, "stageId" | "runId" | "createdAt">
>;

export type UpdateGenerationStageItemPatch = Partial<
  Omit<GenerationStageItem, "itemId" | "stageId" | "createdAt">
>;

// --- Store -----------------------------------------------------------------

export interface GenerationRunsStore {
  createRun(input: CreateGenerationRunInput): Promise<GenerationRun>;
  getRun(runId: string): Promise<GenerationRun | null>;
  updateRun(runId: string, patch: UpdateGenerationRunPatch): Promise<GenerationRun>;
  listRunsForProject(projectId: string): Promise<GenerationRun[]>;

  saveStage(input: CreateGenerationStageInput): Promise<GenerationStage>;
  getStage(stageId: string): Promise<GenerationStage | null>;
  updateStage(
    stageId: string,
    patch: UpdateGenerationStagePatch
  ): Promise<GenerationStage>;
  listStagesForRun(runId: string): Promise<GenerationStage[]>;

  saveStageItem(
    input: CreateGenerationStageItemInput
  ): Promise<GenerationStageItem>;
  getStageItem(itemId: string): Promise<GenerationStageItem | null>;
  updateStageItem(
    itemId: string,
    patch: UpdateGenerationStageItemPatch
  ): Promise<GenerationStageItem>;
  listStageItemsForStage(stageId: string): Promise<GenerationStageItem[]>;
}

const COLLECTIONS = {
  runs: "generation-runs",
  stages: "generation-stages",
  stageItems: "generation-stage-items",
} as const;

function safeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}

function newId(prefix: string): string {
  return `${prefix}_${rand()}`;
}

export function createGenerationRunsStore(rootDir: string): GenerationRunsStore {
  function dir(collection: string): string {
    return path.join(rootDir, collection);
  }

  function file(collection: string, key: string): string {
    return path.join(dir(collection), `${safeKey(key)}.json`);
  }

  async function readJson<T>(
    collection: string,
    key: string
  ): Promise<T | null> {
    try {
      const raw = await fs.readFile(file(collection, key), "utf8");
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async function writeJson<T>(
    collection: string,
    key: string,
    value: T
  ): Promise<T> {
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
    async createRun(input) {
      const now = new Date().toISOString();
      const run: GenerationRun = {
        ...input,
        runId: input.runId ?? newId("genrun"),
        createdAt: now,
        updatedAt: now,
      };
      await writeJson(COLLECTIONS.runs, run.runId, run);
      return run;
    },

    getRun: (runId) => readJson<GenerationRun>(COLLECTIONS.runs, runId),

    async updateRun(runId, patch) {
      const current = await readJson<GenerationRun>(COLLECTIONS.runs, runId);
      if (!current) {
        throw new Error(`generation run not found: ${runId}`);
      }
      const next: GenerationRun = {
        ...current,
        ...patch,
        runId: current.runId,
        projectId: current.projectId,
        createdAt: current.createdAt,
        updatedAt: new Date().toISOString(),
      };
      await writeJson(COLLECTIONS.runs, runId, next);
      return next;
    },

    async listRunsForProject(projectId) {
      const all = await readAll<GenerationRun>(COLLECTIONS.runs);
      return all
        .filter((r) => r.projectId === projectId)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    },

    async saveStage(input) {
      const now = new Date().toISOString();
      const stage: GenerationStage = {
        ...input,
        stageId: input.stageId ?? newId("genstage"),
        createdAt: now,
        updatedAt: now,
      };
      await writeJson(COLLECTIONS.stages, stage.stageId, stage);
      return stage;
    },

    getStage: (stageId) =>
      readJson<GenerationStage>(COLLECTIONS.stages, stageId),

    async updateStage(stageId, patch) {
      const current = await readJson<GenerationStage>(COLLECTIONS.stages, stageId);
      if (!current) {
        throw new Error(`generation stage not found: ${stageId}`);
      }
      const next: GenerationStage = {
        ...current,
        ...patch,
        stageId: current.stageId,
        runId: current.runId,
        createdAt: current.createdAt,
        updatedAt: new Date().toISOString(),
      };
      await writeJson(COLLECTIONS.stages, stageId, next);
      return next;
    },

    async listStagesForRun(runId) {
      const all = await readAll<GenerationStage>(COLLECTIONS.stages);
      return all
        .filter((s) => s.runId === runId)
        .sort((a, b) => a.order - b.order);
    },

    async saveStageItem(input) {
      const now = new Date().toISOString();
      const item: GenerationStageItem = {
        ...input,
        itemId: input.itemId ?? newId("genitem"),
        createdAt: now,
        updatedAt: now,
      };
      await writeJson(COLLECTIONS.stageItems, item.itemId, item);
      return item;
    },

    getStageItem: (itemId) =>
      readJson<GenerationStageItem>(COLLECTIONS.stageItems, itemId),

    async updateStageItem(itemId, patch) {
      const current = await readJson<GenerationStageItem>(
        COLLECTIONS.stageItems,
        itemId
      );
      if (!current) {
        throw new Error(`generation stage item not found: ${itemId}`);
      }
      const next: GenerationStageItem = {
        ...current,
        ...patch,
        itemId: current.itemId,
        stageId: current.stageId,
        createdAt: current.createdAt,
        updatedAt: new Date().toISOString(),
      };
      await writeJson(COLLECTIONS.stageItems, itemId, next);
      return next;
    },

    async listStageItemsForStage(stageId) {
      const all = await readAll<GenerationStageItem>(COLLECTIONS.stageItems);
      return all
        .filter((i) => i.stageId === stageId)
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    },
  };
}

let _store: GenerationRunsStore | null = null;
export function getGenerationRunsStore(): GenerationRunsStore {
  if (!_store) _store = createGenerationRunsStore(defaultDbDir());
  return _store;
}

// Compatibility alias used by PR4 route handlers.
export function getGenerationRunStore(): GenerationRunsStore {
  return getGenerationRunsStore();
}

// Hook for tests that need to inject a deterministic store.
export function setGenerationRunStoreForTests(
  store: GenerationRunsStore | null
): void {
  _store = store;
}

// --- API helpers -----------------------------------------------------------

export interface GenerationRunPayload {
  run: GenerationRun;
  stages: GenerationStage[];
  stageItems: GenerationStageItem[];
  resultArtifacts: GenerationRunResultArtifact[];
}

export interface GenerationRunResultArtifact {
  kind: GenerationStageItem["kind"];
  artifactId: string;
  assetId?: string;
  stageId: string;
  itemId?: string;
}

export interface CreateGenerationRunBody {
  briefVersionId?: string;
  prompt?: string;
}

export interface CreateRunArgs {
  store: GenerationRunsStore;
  projectId: string;
  body: CreateGenerationRunBody;
}

type StageSeed = {
  type: GenerationStageType;
};

const STAGE_SEEDS: StageSeed[] = [
  { type: "brief_intake" },
  { type: "creative_plan" },
  { type: "asset_generation" },
  { type: "audio_generation" },
  { type: "timeline_assembly" },
  { type: "quality_review" },
  { type: "export" },
  { type: "ready" },
];

export async function createRunWithSeedStages(args: CreateRunArgs): Promise<GenerationRunPayload> {
  const { store, projectId, body } = args;
  const parsedBody = body && typeof body === "object" && !Array.isArray(body)
    ? body
    : {};
  const briefVersionId = parsedBody.briefVersionId
    ? String(parsedBody.briefVersionId).trim() || undefined
    : undefined;

  const run = await store.createRun({
    projectId,
    status: "queued" as GenerationRunStatus,
    ...(briefVersionId ? { briefVersionId } : {}),
    currentStageType: "brief_intake",
    progressPercent: 0,
    message: "Run queued.",
  });

  const stages: GenerationStage[] = [];
  for (let i = 0; i < STAGE_SEEDS.length; i += 1) {
    const seed = STAGE_SEEDS[i];
    const stage = await store.saveStage({
      runId: run.runId,
      type: seed.type,
      label: GENERATION_STAGE_LABELS[seed.type],
      order: i,
      status: "queued",
      jobIds: [],
      artifactIds: [],
    });
    stages.push(stage);
  }

  return { run, stages, stageItems: [], resultArtifacts: [] };
}

export async function assemblePayload(
  store: GenerationRunsStore,
  runId: string
): Promise<GenerationRunPayload | null> {
  const run = await store.getRun(runId);
  if (!run) return null;
  const stages = await store.listStagesForRun(runId);

  const stageItems: GenerationStageItem[] = [];
  for (const stage of stages) {
    const items = await store.listStageItemsForStage(stage.stageId);
    stageItems.push(...items);
  }

  return {
    run,
    stages,
    stageItems,
    resultArtifacts: collectResultArtifacts(stages, stageItems),
  };
}

function collectResultArtifacts(
  stages: GenerationStage[],
  stageItems: GenerationStageItem[]
): GenerationRunResultArtifact[] {
  const artifacts: GenerationRunResultArtifact[] = [];
  for (const stage of stages) {
    for (const artifactId of stage.artifactIds) {
      const matchingItem = stageItems.find(
        (i) => i.stageId === stage.stageId && i.artifactId === artifactId
      );
      artifacts.push({
        kind: matchingItem?.kind ?? "export",
        artifactId,
        stageId: stage.stageId,
        ...(matchingItem?.itemId ? { itemId: matchingItem.itemId } : {}),
        ...(matchingItem?.assetId ? { assetId: matchingItem.assetId } : {}),
      });
    }
  }
  return artifacts;
}

export function requireRun(
  payload: GenerationRunPayload | null,
  runId: string,
  projectId: string
): GenerationRunPayload {
  if (!payload || payload.run.projectId !== projectId) {
    throw new ApiError("not_found", `Generation run not found: ${runId}`);
  }
  return payload;
}
