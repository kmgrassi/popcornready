import { promises as fs } from "fs";
import path from "path";

import { defaultDbDir } from "./store";
import {
  GateableGenerationStageType,
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

const GATEABLE_STAGE_TYPES = new Set<GenerationStageType>([
  "brief_intake",
  "creative_plan",
  "asset_generation",
  "audio_generation",
  "timeline_assembly",
  "quality_review",
  "export",
]);

function isGateableStageType(type: GenerationStageType): type is GateableGenerationStageType {
  return GATEABLE_STAGE_TYPES.has(type) && type !== "ready";
}

function parseReviewGates(value: unknown): GateableGenerationStageType[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ApiError("validation_failed", "reviewGates must be an array.", {
      fields: [{ path: "reviewGates", message: "Expected an array of stage types." }],
    });
  }

  const gates: GateableGenerationStageType[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string" || !(raw in GENERATION_STAGE_LABELS)) {
      throw new ApiError("validation_failed", "reviewGates contains an unknown stage.", {
        fields: [{ path: "reviewGates", message: "Use only known generation stage types." }],
      });
    }
    const type = raw as GenerationStageType;
    if (!isGateableStageType(type)) {
      throw new ApiError("validation_failed", "reviewGates contains a non-gateable stage.", {
        fields: [{ path: "reviewGates", message: "ready cannot be used as a review gate." }],
      });
    }
    if (!seen.has(type)) {
      seen.add(type);
      gates.push(type);
    }
  }
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
  const reviewGates = parseReviewGates(parsedBody.reviewGates);

  const run = await store.createRun({
    projectId,
    status: "queued" as GenerationRunStatus,
    ...(briefVersionId ? { briefVersionId } : {}),
    reviewGates,
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
      ...(reviewGates.includes(seed.type as GateableGenerationStageType)
        ? { isReviewGate: true }
        : {}),
      jobIds: [],
      artifactIds: [],
    });
    stages.push(stage);
  }

  return { run, stages, stageItems: [], resultArtifacts: [] };
}

export async function approveReviewGate(
  store: GenerationRunsStore,
  runId: string
): Promise<GenerationRunPayload> {
  const payload = requireExistingPayload(await assemblePayload(store, runId), runId);
  const { run, stages } = payload;
  if (isTerminalRunStatus(run.status)) {
    throw new ApiError("job_not_cancelable", "Terminal generation runs cannot be approved.", {
      status: run.status,
    });
  }
  if (!run.reviewGate) {
    return payload;
  }

  const gate = run.reviewGate;
  const stage = stages.find((s) => s.stageId === gate.stageId);
  if (!stage || stage.type !== gate.stageType) {
    throw new ApiError("validation_failed", "The current review gate no longer matches a stage.");
  }

  const reviewedAt = new Date().toISOString();
  await store.updateStage(stage.stageId, { reviewedAt });

  const nextStage = stages.find((s) => s.order > stage.order && s.status === "queued");
  await store.updateRun(run.runId, {
    reviewGate: null,
    currentStageType: nextStage?.type ?? run.currentStageType,
    message: nextStage
      ? `Approved ${stage.label}; continuing to ${nextStage.label}.`
      : `Approved ${stage.label}.`,
  });

  return requireExistingPayload(await assemblePayload(store, runId), runId);
}

export async function pauseAfterStageIfReviewGate(
  store: GenerationRunsStore,
  runId: string,
  stageId: string
): Promise<GenerationRunPayload> {
  const payload = requireExistingPayload(await assemblePayload(store, runId), runId);
  const { run, stages } = payload;
  const stage = stages.find((s) => s.stageId === stageId);
  if (!stage || !stage.isReviewGate || stage.status !== "succeeded") {
    return payload;
  }
  if (isTerminalRunStatus(run.status)) {
    return payload;
  }
  await store.updateRun(run.runId, {
    status: "running",
    currentStageType: stage.type,
    reviewGate: {
      stageType: stage.type as GateableGenerationStageType,
      stageId: stage.stageId,
      state: "awaiting_review",
      enteredAt: new Date().toISOString(),
    },
    message: `${stage.label} is ready for review.`,
  });
  return requireExistingPayload(await assemblePayload(store, runId), runId);
}

export async function rejectReviewGate(
  store: GenerationRunsStore,
  runId: string,
  body: unknown
): Promise<GenerationRunPayload> {
  const payload = requireExistingPayload(await assemblePayload(store, runId), runId);
  const { run, stages } = payload;
  if (isTerminalRunStatus(run.status)) {
    throw new ApiError("job_not_cancelable", "Terminal generation runs cannot be rejected.", {
      status: run.status,
    });
  }
  if (!run.reviewGate) {
    throw new ApiError("validation_failed", "Run is not awaiting review.");
  }

  const parsed = body && typeof body === "object" && !Array.isArray(body)
    ? (body as { stageType?: unknown; note?: unknown })
    : {};
  const gate = run.reviewGate;
  if (parsed.stageType !== undefined && parsed.stageType !== gate.stageType) {
    throw new ApiError("validation_failed", "Reject stageType must match the active review gate.", {
      fields: [{ path: "stageType", message: `Expected ${gate.stageType}.` }],
    });
  }

  const stage = stages.find((s) => s.stageId === gate.stageId);
  if (!stage || stage.type !== gate.stageType) {
    throw new ApiError("validation_failed", "The current review gate no longer matches a stage.");
  }
  const note = typeof parsed.note === "string" ? parsed.note.trim() : "";
  const enteredAt = new Date().toISOString();

  await store.updateStage(stage.stageId, {
    status: "succeeded",
    progressPercent: 100,
    reviewedAt: undefined,
    completedAt: enteredAt,
    error: undefined,
    message: note
      ? `Regenerated after feedback: ${note}`
      : "Regenerated after review feedback.",
  });
  await store.updateRun(run.runId, {
    status: "running",
    currentStageType: stage.type,
    reviewGate: {
      stageType: stage.type as GateableGenerationStageType,
      stageId: stage.stageId,
      state: "awaiting_review",
      enteredAt,
    },
    message: `${stage.label} regenerated and ready for review.`,
  });

  return requireExistingPayload(await assemblePayload(store, runId), runId);
}

export async function cancelGenerationRun(
  store: GenerationRunsStore,
  runId: string
): Promise<GenerationRunPayload> {
  const payload = requireExistingPayload(await assemblePayload(store, runId), runId);
  const { run, stages } = payload;
  if (isTerminalRunStatus(run.status)) {
    throw new ApiError("job_not_cancelable", "Run already finished.", {
      code: "job_not_cancelable",
      message: "Run already finished.",
      retryable: false,
    });
  }

  const canceledAt = new Date().toISOString();
  await store.updateRun(run.runId, {
    status: "canceled",
    reviewGate: null,
    completedAt: canceledAt,
    message: "Generation run canceled.",
  });
  await Promise.all(
    stages
      .filter((stage) => stage.status === "queued" || stage.status === "running")
      .map((stage) =>
        store.updateStage(stage.stageId, {
          status: "canceled",
          completedAt: canceledAt,
          message: "Canceled before this stage completed.",
        })
      )
  );

  return requireExistingPayload(await assemblePayload(store, runId), runId);
}

function isTerminalRunStatus(status: GenerationRunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

function requireExistingPayload(
  payload: GenerationRunPayload | null,
  runId: string
): GenerationRunPayload {
  if (!payload) throw new ApiError("not_found", `Generation run not found: ${runId}`);
  return payload;
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
