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
  RunReviewGate,
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
  reviewGates?: unknown;
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

export const GATEABLE_GENERATION_STAGES: readonly GenerationStageType[] = [
  "brief_intake",
  "creative_plan",
  "asset_generation",
  "audio_generation",
  "timeline_assembly",
  "quality_review",
  "export",
];

const GATEABLE_STAGE_SET = new Set<GenerationStageType>(GATEABLE_GENERATION_STAGES);
const TERMINAL_RUN_STATUSES = new Set<GenerationRunStatus>([
  "succeeded",
  "failed",
  "canceled",
]);
const ACTIVE_RUN_STATUSES = new Set<GenerationRunStatus>(["queued", "running"]);

export function validateReviewGates(value: unknown): GenerationStageType[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ApiError("validation_failed", "reviewGates must be an array.", {
      fields: [{ path: "reviewGates", message: "Must be an array of gateable stage types." }],
    });
  }

  const gates: GenerationStageType[] = [];
  const seen = new Set<GenerationStageType>();
  value.forEach((raw, index) => {
    if (typeof raw !== "string" || !GATEABLE_STAGE_SET.has(raw as GenerationStageType)) {
      throw new ApiError("validation_failed", "reviewGates contains an invalid stage type.", {
        fields: [
          {
            path: `reviewGates.${index}`,
            message: "Must be one of the gateable stage types; ready cannot be gated.",
          },
        ],
      });
    }
    const stage = raw as GenerationStageType;
    if (!seen.has(stage)) {
      seen.add(stage);
      gates.push(stage);
    }
  });

  return gates;
}

export async function createRunWithSeedStages(args: CreateRunArgs): Promise<GenerationRunPayload> {
  const { store, projectId, body } = args;
  const parsedBody = body && typeof body === "object" && !Array.isArray(body)
    ? body
    : {};
  const reviewGates = validateReviewGates(parsedBody.reviewGates);
  const briefVersionId = parsedBody.briefVersionId
    ? String(parsedBody.briefVersionId).trim() || undefined
    : undefined;

  const run = await store.createRun({
    projectId,
    status: "queued" as GenerationRunStatus,
    ...(briefVersionId ? { briefVersionId } : {}),
    ...(reviewGates.length > 0 ? { reviewGates } : {}),
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
      ...(reviewGates.includes(seed.type) ? { isReviewGate: true } : {}),
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

export async function completeStageAndMaybePauseAtGate(args: {
  store: GenerationRunsStore;
  runId: string;
  stageId: string;
  message?: string;
}): Promise<GenerationRunPayload> {
  const { store, runId, stageId, message } = args;
  const run = await store.getRun(runId);
  if (!run) throw new ApiError("not_found", `Generation run not found: ${runId}`);
  const stage = await store.getStage(stageId);
  if (!stage || stage.runId !== runId) {
    throw new ApiError("not_found", `Generation stage not found: ${stageId}`);
  }

  const now = new Date().toISOString();
  const completed = await store.updateStage(stageId, {
    status: "succeeded",
    progressPercent: 100,
    completedAt: now,
    ...(message ? { message } : {}),
  });

  if (completed.isReviewGate && completed.type !== "ready") {
    const reviewGate: RunReviewGate = {
      stageType: completed.type,
      stageId: completed.stageId,
      state: "awaiting_review",
      enteredAt: now,
    };
    await store.updateRun(runId, {
      status: "running",
      currentStageType: completed.type,
      reviewGate,
      progressPercent: progressAfterStage(completed),
      message: "Ready for your review.",
    });
  } else {
    await startNextStageAfter(store, run, completed);
  }

  const payload = await assemblePayload(store, runId);
  if (!payload) throw new ApiError("not_found", `Generation run not found: ${runId}`);
  return payload;
}

export async function approveGenerationRunGate(args: {
  store: GenerationRunsStore;
  runId: string;
  projectId: string;
}): Promise<GenerationRunPayload> {
  const { store, runId, projectId } = args;
  const payload = requireRun(await assemblePayload(store, runId), runId, projectId);
  const { run, stages } = payload;

  if (TERMINAL_RUN_STATUSES.has(run.status)) {
    throw new ApiError(
      "job_not_cancelable",
      `Generation run ${runId} is ${run.status} and cannot be approved.`,
      { status: run.status }
    );
  }

  if (!run.reviewGate) {
    if (ACTIVE_RUN_STATUSES.has(run.status)) return payload;
    throw new ApiError(
      "job_not_cancelable",
      `Generation run ${runId} is ${run.status} and cannot be approved.`,
      { status: run.status }
    );
  }

  const gatedStage = stages.find((stage) => stage.stageId === run.reviewGate?.stageId);
  if (!gatedStage) {
    throw new ApiError(
      "validation_failed",
      `Review gate points at a missing stage: ${run.reviewGate.stageId}`
    );
  }

  const reviewedAt = new Date().toISOString();
  const reviewedStage = await store.updateStage(gatedStage.stageId, {
    reviewedAt,
    status: "succeeded",
    progressPercent: 100,
    completedAt: gatedStage.completedAt ?? reviewedAt,
  });
  const updatedRun = await store.updateRun(runId, {
    reviewGate: null,
    status: "running",
    message: `${reviewedStage.label} approved.`,
  });
  await startNextStageAfter(store, updatedRun, reviewedStage);

  const nextPayload = await assemblePayload(store, runId);
  if (!nextPayload) throw new ApiError("not_found", `Generation run not found: ${runId}`);
  return nextPayload;
}

async function startNextStageAfter(
  store: GenerationRunsStore,
  run: GenerationRun,
  completedStage: GenerationStage
): Promise<void> {
  const stages = await store.listStagesForRun(run.runId);
  const nextStage = stages.find((stage) => stage.order > completedStage.order);
  if (!nextStage) {
    await store.updateRun(run.runId, {
      status: "succeeded",
      currentStageType: "ready",
      progressPercent: 100,
      message: "Your video is ready.",
      completedAt: new Date().toISOString(),
      reviewGate: null,
    });
    return;
  }

  const now = new Date().toISOString();
  await store.updateStage(nextStage.stageId, {
    status: "running",
    startedAt: nextStage.startedAt ?? now,
    progressPercent: nextStage.progressPercent ?? 0,
  });
  await store.updateRun(run.runId, {
    status: "running",
    currentStageType: nextStage.type,
    progressPercent: Math.round((nextStage.order / STAGE_SEEDS.length) * 100),
    message: `Running ${nextStage.label}.`,
    reviewGate: null,
    startedAt: run.startedAt ?? now,
  });
}

function progressAfterStage(stage: GenerationStage): number {
  return Math.round(((stage.order + 1) / STAGE_SEEDS.length) * 100);
}
