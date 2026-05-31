import { promises as fs } from "fs";
import path from "path";

import { defaultDbDir } from "./store";
import {
  GATEABLE_GENERATION_STAGE_TYPES,
  GENERATION_STAGE_LABELS,
  GateableGenerationStageType,
  GenerationRun,
  GenerationRunStatus,
  GenerationStage,
  GenerationStageItem,
  GenerationStageType,
} from "./types";
import { ApiError } from "./errors";
import {
  BeginStageOptions,
  RunProgressEmitter,
  RunStageHandle,
  RunStageItemHandle,
  StageItemSucceedOptions,
  StageSucceedOptions,
  StageUpdate,
  StartStageItemOptions,
} from "./generation-progress";

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

const GATEABLE_STAGE_SET = new Set<GenerationStageType>(
  GATEABLE_GENERATION_STAGE_TYPES
);

export function isGateableGenerationStageType(
  value: unknown
): value is GateableGenerationStageType {
  return typeof value === "string" && GATEABLE_STAGE_SET.has(value as GenerationStageType);
}

function parseReviewGates(body: CreateGenerationRunBody): GateableGenerationStageType[] {
  if (body.reviewGates === undefined || body.reviewGates === null) return [];
  if (!Array.isArray(body.reviewGates)) {
    throw new ApiError("validation_failed", "reviewGates must be an array.", {
      fields: [{ path: "reviewGates", message: "Must be an array of stage types." }],
    });
  }

  const gates: GateableGenerationStageType[] = [];
  const seen = new Set<GateableGenerationStageType>();
  body.reviewGates.forEach((raw, index) => {
    if (!isGateableGenerationStageType(raw)) {
      throw new ApiError("validation_failed", "reviewGates contains an invalid stage type.", {
        fields: [
          {
            path: `reviewGates.${index}`,
            message: "Must be a gateable generation stage type.",
          },
        ],
      });
    }
    if (!seen.has(raw)) {
      seen.add(raw);
      gates.push(raw);
    }
  });
  return gates;
}

export async function createRunWithSeedStages(args: CreateRunArgs): Promise<GenerationRunPayload> {
  const { store, projectId, body } = args;
  const parsedBody = body && typeof body === "object" && !Array.isArray(body)
    ? body
    : {};
  const briefVersionId = parsedBody.briefVersionId
    ? String(parsedBody.briefVersionId).trim() || undefined
    : undefined;
  const reviewGates = parseReviewGates(parsedBody);
  const reviewGateSet = new Set<GenerationStageType>(reviewGates);

  const run = await store.createRun({
    projectId,
    status: "queued" as GenerationRunStatus,
    ...(briefVersionId ? { briefVersionId } : {}),
    ...(reviewGates.length > 0 ? { reviewGates } : {}),
    reviewGate: null,
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
      ...(reviewGateSet.has(seed.type) ? { isReviewGate: true } : {}),
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

export class RunReviewGatePaused extends Error {
  readonly runId: string;
  readonly stageId: string;
  readonly stageType: GateableGenerationStageType;

  constructor(args: {
    runId: string;
    stageId: string;
    stageType: GateableGenerationStageType;
  }) {
    super(`Generation run ${args.runId} paused for review after ${args.stageType}.`);
    this.name = "RunReviewGatePaused";
    this.runId = args.runId;
    this.stageId = args.stageId;
    this.stageType = args.stageType;
  }
}

export function isRunReviewGatePaused(err: unknown): err is RunReviewGatePaused {
  return err instanceof RunReviewGatePaused;
}

export function createPersistedRunProgressEmitter(
  store: GenerationRunsStore,
  runId: string
): RunProgressEmitter {
  async function getRunOrThrow(): Promise<GenerationRun> {
    const run = await store.getRun(runId);
    if (!run) throw new Error(`generation run not found: ${runId}`);
    return run;
  }

  async function getStageByType(type: GenerationStageType): Promise<GenerationStage> {
    const stages = await store.listStagesForRun(runId);
    const stage = stages.find((s) => s.type === type);
    if (!stage) {
      throw new Error(`generation stage not found for ${type} on run ${runId}`);
    }
    return stage;
  }

  function stageHandle(stageId: string, type: GenerationStageType): RunStageHandle {
    async function getStage(): Promise<GenerationStage> {
      const stage = await store.getStage(stageId);
      if (!stage) throw new Error(`generation stage not found: ${stageId}`);
      return stage;
    }

    async function updateRunSummary(patch: StageUpdate): Promise<void> {
      await store.updateRun(runId, {
        status: "running",
        currentStageType: type,
        ...patch,
      });
    }

    return {
      type,

      async update(patch) {
        await store.updateStage(stageId, patch);
        await updateRunSummary(patch);
      },

      async startItem(opts: StartStageItemOptions): Promise<RunStageItemHandle> {
        const item = await store.saveStageItem({
          stageId,
          kind: opts.kind,
          label: opts.label,
          status: "running",
          progressPercent: 0,
          ...(opts.provider ? { provider: opts.provider } : {}),
          ...(opts.promptPreview ? { promptPreview: opts.promptPreview } : {}),
        });

        return {
          itemId: item.itemId,
          async update(patch) {
            await store.updateStageItem(item.itemId, patch);
          },
          async succeed(opts?: StageItemSucceedOptions) {
            await store.updateStageItem(item.itemId, {
              status: "succeeded",
              progressPercent: 100,
              ...(opts?.assetId ? { assetId: opts.assetId } : {}),
              ...(opts?.artifactId ? { artifactId: opts.artifactId } : {}),
              ...(opts?.message ? { message: opts.message } : {}),
            });
          },
          async fail(error) {
            await store.updateStageItem(item.itemId, {
              status: "failed",
              error,
            });
          },
        };
      },

      async attachJob(jobId) {
        const stage = await getStage();
        await store.updateStage(stageId, {
          jobIds: stage.jobIds.includes(jobId)
            ? stage.jobIds
            : [...stage.jobIds, jobId],
        });
      },

      async attachArtifact(artifactId) {
        const stage = await getStage();
        await store.updateStage(stageId, {
          artifactIds: stage.artifactIds.includes(artifactId)
            ? stage.artifactIds
            : [...stage.artifactIds, artifactId],
        });
      },

      async succeed(opts?: StageSucceedOptions) {
        const now = new Date().toISOString();
        const completed = await store.updateStage(stageId, {
          status: "succeeded",
          progressPercent: 100,
          completedAt: now,
          ...(opts?.message ? { message: opts.message } : {}),
        });

        if (
          completed.isReviewGate &&
          isGateableGenerationStageType(completed.type)
        ) {
          await store.updateRun(runId, {
            status: "running",
            currentStageType: completed.type,
            reviewGate: {
              stageType: completed.type,
              stageId: completed.stageId,
              state: "awaiting_review",
              enteredAt: now,
            },
            progressPercent: completed.progressPercent,
            message: opts?.message ?? `${completed.label} is ready for review.`,
          });
          throw new RunReviewGatePaused({
            runId,
            stageId: completed.stageId,
            stageType: completed.type,
          });
        }

        await store.updateRun(runId, {
          status: "running",
          currentStageType: completed.type,
          progressPercent: completed.progressPercent,
          message: opts?.message ?? completed.message,
        });
      },

      async fail(error) {
        const now = new Date().toISOString();
        await store.updateStage(stageId, {
          status: "failed",
          completedAt: now,
          error,
        });
        await store.updateRun(runId, {
          status: "failed",
          currentStageType: type,
          completedAt: now,
          error,
        });
      },

      async cancel(opts) {
        const now = new Date().toISOString();
        await store.updateStage(stageId, {
          status: "canceled",
          completedAt: now,
          ...(opts?.message ? { message: opts.message } : {}),
        });
        await store.updateRun(runId, {
          status: "canceled",
          currentStageType: type,
          completedAt: now,
          reviewGate: null,
          ...(opts?.message ? { message: opts.message } : {}),
        });
      },
    };
  }

  return {
    async beginStage(type: GenerationStageType, opts?: BeginStageOptions) {
      const run = await getRunOrThrow();
      const stage = await getStageByType(type);
      const now = new Date().toISOString();
      await store.updateRun(runId, {
        status: "running",
        currentStageType: type,
        ...(run.startedAt ? {} : { startedAt: now }),
        ...(opts?.message ? { message: opts.message } : {}),
      });
      const updated = await store.updateStage(stage.stageId, {
        status: "running",
        ...(stage.startedAt ? {} : { startedAt: now }),
        ...(opts?.label ? { label: opts.label } : {}),
        ...(opts?.message ? { message: opts.message } : {}),
        ...(typeof opts?.order === "number" ? { order: opts.order } : {}),
      });
      return stageHandle(updated.stageId, updated.type);
    },

    async updateRun(patch: StageUpdate) {
      await store.updateRun(runId, patch);
    },
  };
}
