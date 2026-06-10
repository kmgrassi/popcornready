import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getServiceSupabase } from "../supabase-client";
import { databaseError, isMissingRow } from "../../supabase/db-errors";
import {
  GENERATION_STAGE_LABELS,
  GENERATION_STAGE_ORDER,
  GenerationRun,
  GenerationStage,
  GenerationStageItem,
  GenerationStageType,
} from "@popcorn/shared/v1/types";

// Persistence for generation runs, stages, and stage items.
//
// The production store (createSupabaseGenerationRunsStore, used by
// getGenerationRunsStore) reads/writes the generation_runs / generation_stages /
// generation_stage_items tables in Supabase Postgres
// (supabase/migrations/20260603000000_init_v1_model.sql). Snake_case columns map
// to/from the camelCase wire shapes below; jsonb columns carry the loosely-shaped
// fields (error summaries, jobIds/artifactIds arrays). A file-based store
// (createGenerationRunsStore(rootDir)) is retained for offline unit tests.

// --- Input/patch types -----------------------------------------------------

// Ids are DB-generated (uuid default gen_random_uuid); create inputs never carry
// an id — the store reads the generated id back and returns it on the entity.
export type CreateGenerationRunInput = Omit<
  GenerationRun,
  "runId" | "createdAt" | "updatedAt"
>;

export type CreateGenerationStageInput = Omit<
  GenerationStage,
  "stageId" | "createdAt" | "updatedAt"
>;

export type CreateGenerationStageItemInput = Omit<
  GenerationStageItem,
  "itemId" | "createdAt" | "updatedAt"
>;

export type UpdateGenerationRunPatch = Partial<
  Omit<GenerationRun, "runId" | "projectId" | "createdAt">
>;

export type UpdateGenerationStagePatch = Partial<
  Omit<GenerationStage, "stageId" | "runId" | "createdAt">
>;

export type UpdateGenerationStageItemPatch = Partial<
  Omit<GenerationStageItem, "itemId" | "stageId" | "createdAt">
>;

// A stage/item's output persisted as a first-class, addressable artifact so an
// evaluator can read it as evidence after the producing step succeeds (Stage
// Eval Framework §3 "Evidence-bearing hook"). The plan, the assembled timeline,
// and similar structured outputs are stored here keyed by `artifactId`; the
// stage/item that produced them carries the same id via `attachArtifact` /
// `resultArtifactId`, so the run graph references it while the bytes live here.
export interface GenerationStageArtifact {
  artifactId: string;
  runId: string;
  stageId: string;
  itemId?: string;
  kind: GenerationStageItem["kind"];
  // The structured output (plan, timeline, …) the evaluator reads. JSON-shaped.
  content: unknown;
  createdAt: string;
}

export type CreateGenerationStageArtifactInput = Omit<
  GenerationStageArtifact,
  "artifactId" | "createdAt"
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

  saveStageArtifact(
    input: CreateGenerationStageArtifactInput
  ): Promise<GenerationStageArtifact>;
  getStageArtifact(artifactId: string): Promise<GenerationStageArtifact | null>;
}

const COLLECTIONS = {
  runs: "generation-runs",
  stages: "generation-stages",
  stageItems: "generation-stage-items",
  stageArtifacts: "generation-stage-artifacts",
} as const;

function safeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

// ---------------------------------------------------------------------------
// Supabase (Postgres) implementation
// ---------------------------------------------------------------------------

function isMissing(error: { code?: string } | null): boolean {
  return isMissingRow(error);
}

function fail(op: string, error: { message?: string } | null): never {
  throw databaseError(`generation-runs store.${op}`, error);
}

// --- runs ------------------------------------------------------------------

interface RunRow {
  id: string;
  project_id: string;
  status: GenerationRun["status"];
  progress_percent: number | null;
  message: string | null;
  error: GenerationRun["error"] | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  gates: unknown;
}

const RUN_STATE_VERSION = "generationRunState.v1";

interface StoredRunState {
  v: typeof RUN_STATE_VERSION;
  briefVersionId?: string;
  reviewGates?: GenerationRun["reviewGates"];
  reviewGate?: GenerationRun["reviewGate"] | null;
  reviewFeedback?: string | null;
  currentStageType?: GenerationRun["currentStageType"];
  stages: GenerationStage[];
  stageItems: GenerationStageItem[];
  stageArtifacts: GenerationStageArtifact[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRunState(value: unknown): StoredRunState {
  if (isRecord(value) && value.v === RUN_STATE_VERSION) {
    return {
      v: RUN_STATE_VERSION,
      briefVersionId:
        typeof value.briefVersionId === "string" ? value.briefVersionId : undefined,
      reviewGates: Array.isArray(value.reviewGates)
        ? (value.reviewGates as GenerationRun["reviewGates"])
        : undefined,
      reviewGate: isRecord(value.reviewGate)
        ? (value.reviewGate as unknown as GenerationRun["reviewGate"])
        : value.reviewGate === null
          ? null
          : undefined,
      reviewFeedback:
        typeof value.reviewFeedback === "string"
          ? value.reviewFeedback
          : value.reviewFeedback === null
            ? null
            : undefined,
      currentStageType:
        typeof value.currentStageType === "string"
          ? (value.currentStageType as GenerationRun["currentStageType"])
          : undefined,
      stages: Array.isArray(value.stages) ? (value.stages as GenerationStage[]) : [],
      stageItems: Array.isArray(value.stageItems)
        ? (value.stageItems as GenerationStageItem[])
        : [],
      stageArtifacts: Array.isArray(value.stageArtifacts)
        ? (value.stageArtifacts as GenerationStageArtifact[])
        : [],
    };
  }
  return {
    v: RUN_STATE_VERSION,
    reviewGates: Array.isArray(value) ? (value as GenerationRun["reviewGates"]) : undefined,
    stages: [],
    stageItems: [],
    stageArtifacts: [],
  };
}

function runStateFromRun(run: GenerationRun): StoredRunState {
  return {
    v: RUN_STATE_VERSION,
    briefVersionId: run.briefVersionId,
    reviewGates: run.reviewGates,
    reviewGate: run.reviewGate,
    reviewFeedback: run.reviewFeedback,
    currentStageType: run.currentStageType,
    stages: [],
    stageItems: [],
    stageArtifacts: [],
  };
}

function rowToRun(r: RunRow): GenerationRun {
  const state = parseRunState(r.gates);
  const run: GenerationRun = {
    runId: r.id,
    projectId: r.project_id,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (state.briefVersionId != null) run.briefVersionId = state.briefVersionId;
  if (state.reviewGates != null) run.reviewGates = state.reviewGates;
  if (state.reviewGate !== undefined) run.reviewGate = state.reviewGate;
  if (state.reviewFeedback !== undefined) run.reviewFeedback = state.reviewFeedback;
  if (state.currentStageType != null) run.currentStageType = state.currentStageType;
  if (r.progress_percent != null) run.progressPercent = r.progress_percent;
  if (r.message != null) run.message = r.message;
  if (r.started_at != null) run.startedAt = r.started_at;
  if (r.completed_at != null) run.completedAt = r.completed_at;
  if (r.error != null) run.error = r.error;
  return run;
}

function runToRow(run: GenerationRun): RunRow {
  return {
    id: run.runId,
    project_id: run.projectId,
    status: run.status,
    progress_percent: run.progressPercent ?? null,
    message: run.message ?? null,
    error: run.error ?? null,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
    started_at: run.startedAt ?? null,
    completed_at: run.completedAt ?? null,
    gates: runStateFromRun(run),
  };
}

function runIdFromStageId(stageId: string): string {
  return stageId.split(":")[0] || stageId;
}

function stageIdFromItemId(itemId: string): string {
  return itemId.split(":item:")[0] || itemId;
}

function stageIdFromArtifactId(artifactId: string): string {
  return artifactId.split(":artifact:")[0] || artifactId;
}

function syntheticStages(row: RunRow): GenerationStage[] {
  const run = rowToRun(row);
  const reviewGates = new Set(run.reviewGates ?? []);
  const currentOrder =
    run.currentStageType != null ? GENERATION_STAGE_ORDER[run.currentStageType] : 0;
  return (Object.keys(GENERATION_STAGE_ORDER) as GenerationStageType[]).map((type) => {
    const order = GENERATION_STAGE_ORDER[type];
    const status: GenerationRun["status"] =
      run.status === "succeeded" || run.status === "failed" || run.status === "canceled"
        ? run.status
        : order < currentOrder
          ? "succeeded"
          : order === currentOrder
            ? run.status
            : "queued";
    return {
      stageId: `${run.runId}:${type}`,
      runId: run.runId,
      type,
      label: GENERATION_STAGE_LABELS[type],
      order,
      status,
      isReviewGate: reviewGates.has(type as never),
      jobIds: [],
      artifactIds: [],
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    };
  });
}

// --- stages ----------------------------------------------------------------

interface StageRow {
  id: string;
  run_id: string;
  type: GenerationStage["type"];
  label: string;
  order: number;
  status: GenerationStage["status"];
  is_review_gate: boolean | null;
  reviewed_at: string | null;
  progress_percent: number | null;
  message: string | null;
  started_at: string | null;
  completed_at: string | null;
  job_ids: string[];
  artifact_ids: string[];
  error: GenerationStage["error"] | null;
  judgment: GenerationStage["judgment"] | null;
  created_at: string;
  updated_at: string;
}

function rowToStage(r: StageRow): GenerationStage {
  const stage: GenerationStage = {
    stageId: r.id,
    runId: r.run_id,
    type: r.type,
    label: r.label,
    order: r.order,
    status: r.status,
    jobIds: r.job_ids ?? [],
    artifactIds: r.artifact_ids ?? [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (r.is_review_gate != null) stage.isReviewGate = r.is_review_gate;
  if (r.reviewed_at != null) stage.reviewedAt = r.reviewed_at;
  if (r.progress_percent != null) stage.progressPercent = r.progress_percent;
  if (r.message != null) stage.message = r.message;
  if (r.started_at != null) stage.startedAt = r.started_at;
  if (r.completed_at != null) stage.completedAt = r.completed_at;
  if (r.error != null) stage.error = r.error;
  if (r.judgment != null) stage.judgment = r.judgment;
  return stage;
}

function stageToRow(s: GenerationStage): StageRow {
  return {
    id: s.stageId,
    run_id: s.runId,
    type: s.type,
    label: s.label,
    order: s.order,
    status: s.status,
    is_review_gate: s.isReviewGate ?? null,
    reviewed_at: s.reviewedAt ?? null,
    progress_percent: s.progressPercent ?? null,
    message: s.message ?? null,
    started_at: s.startedAt ?? null,
    completed_at: s.completedAt ?? null,
    job_ids: s.jobIds ?? [],
    artifact_ids: s.artifactIds ?? [],
    error: s.error ?? null,
    judgment: s.judgment ?? null,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  };
}

// --- stage items -----------------------------------------------------------

interface StageItemRow {
  id: string;
  stage_id: string;
  kind: GenerationStageItem["kind"];
  label: string;
  status: GenerationStageItem["status"];
  progress_percent: number | null;
  provider: string | null;
  prompt_preview: string | null;
  asset_id: string | null;
  artifact_id: string | null;
  retryable: boolean | null;
  error: GenerationStageItem["error"] | null;
  judgment: GenerationStageItem["judgment"] | null;
  created_at: string;
  updated_at: string;
}

function rowToStageItem(r: StageItemRow): GenerationStageItem {
  const item: GenerationStageItem = {
    itemId: r.id,
    stageId: r.stage_id,
    kind: r.kind,
    label: r.label,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (r.progress_percent != null) item.progressPercent = r.progress_percent;
  if (r.provider != null) item.provider = r.provider;
  if (r.prompt_preview != null) item.promptPreview = r.prompt_preview;
  if (r.asset_id != null) item.assetId = r.asset_id;
  if (r.artifact_id != null) item.artifactId = r.artifact_id;
  if (r.retryable != null) item.retryable = r.retryable;
  if (r.error != null) item.error = r.error;
  if (r.judgment != null) item.judgment = r.judgment;
  return item;
}

function stageItemToRow(i: GenerationStageItem): StageItemRow {
  return {
    id: i.itemId,
    stage_id: i.stageId,
    kind: i.kind,
    label: i.label,
    status: i.status,
    progress_percent: i.progressPercent ?? null,
    provider: i.provider ?? null,
    prompt_preview: i.promptPreview ?? null,
    asset_id: i.assetId ?? null,
    artifact_id: i.artifactId ?? null,
    retryable: i.retryable ?? null,
    error: i.error ?? null,
    judgment: i.judgment ?? null,
    created_at: i.createdAt,
    updated_at: i.updatedAt,
  };
}

// --- stage artifacts -------------------------------------------------------

interface StageArtifactRow {
  id: string;
  run_id: string;
  stage_id: string;
  item_id: string | null;
  kind: GenerationStageItem["kind"];
  content: unknown;
  created_at: string;
}

function rowToStageArtifact(r: StageArtifactRow): GenerationStageArtifact {
  const artifact: GenerationStageArtifact = {
    artifactId: r.id,
    runId: r.run_id,
    stageId: r.stage_id,
    kind: r.kind,
    content: r.content,
    createdAt: r.created_at,
  };
  if (r.item_id != null) artifact.itemId = r.item_id;
  return artifact;
}

function stageArtifactToRow(a: GenerationStageArtifact): StageArtifactRow {
  return {
    id: a.artifactId,
    run_id: a.runId,
    stage_id: a.stageId,
    item_id: a.itemId ?? null,
    kind: a.kind,
    content: a.content,
    created_at: a.createdAt,
  };
}

export function createSupabaseGenerationRunsStore(
  db: SupabaseClient = getServiceSupabase()
): GenerationRunsStore {
  async function getRunRow(runId: string): Promise<RunRow | null> {
    const { data, error } = await db
      .from("generation_runs")
      .select("*")
      .eq("id", runId)
      .single();
    if (error) {
      if (isMissing(error)) return null;
      fail("get run", error);
    }
    return (data as RunRow | null) ?? null;
  }

  async function writeRunState(runId: string, state: StoredRunState): Promise<void> {
    const { error } = await db
      .from("generation_runs")
      .update({ gates: state, updated_at: new Date().toISOString() })
      .eq("id", runId);
    if (error) fail("update run state", error);
  }

  async function requireRunState(runId: string): Promise<{ row: RunRow; state: StoredRunState }> {
    const row = await getRunRow(runId);
    if (!row) throw new Error(`generation run not found: ${runId}`);
    return { row, state: parseRunState(row.gates) };
  }

  function stagesForRow(row: RunRow): GenerationStage[] {
    const state = parseRunState(row.gates);
    return state.stages.length ? state.stages : syntheticStages(row);
  }

  return {
    async createRun(input) {
      const now = new Date().toISOString();
      // Omit the id so Postgres assigns it; read the generated id back.
      const { id: _omit, ...row } = runToRow({
        ...input,
        runId: "",
        createdAt: now,
        updatedAt: now,
      });
      void _omit;
      const { data, error } = await db
        .from("generation_runs")
        .insert(row)
        .select("*")
        .single();
      if (error) fail("create run", error);
      return rowToRun(data as RunRow);
    },

    async getRun(runId) {
      const row = await getRunRow(runId);
      return row ? rowToRun(row) : null;
    },

    async updateRun(runId, patch) {
      const currentRow = await getRunRow(runId);
      if (!currentRow) throw new Error(`generation run not found: ${runId}`);
      const current = rowToRun(currentRow);
      const currentState = parseRunState(currentRow.gates);
      const next: GenerationRun = {
        ...current,
        ...patch,
        runId: current.runId,
        projectId: current.projectId,
        createdAt: current.createdAt,
        updatedAt: new Date().toISOString(),
      };
      const nextState: StoredRunState = {
        ...currentState,
        briefVersionId: next.briefVersionId,
        reviewGates: next.reviewGates,
        reviewGate: next.reviewGate,
        reviewFeedback: next.reviewFeedback,
        currentStageType: next.currentStageType,
      };
      const { error } = await db
        .from("generation_runs")
        .update({ ...runToRow(next), gates: nextState })
        .eq("id", runId);
      if (error) fail("update run", error);
      return next;
    },

    async listRunsForProject(projectId) {
      const { data, error } = await db
        .from("generation_runs")
        .select("*")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false });
      if (error) fail("list runs", error);
      return ((data as RunRow[]) ?? []).map(rowToRun);
    },

    async saveStage(input) {
      const now = new Date().toISOString();
      const { state } = await requireRunState(input.runId);
      const stage: GenerationStage = {
        ...input,
        stageId: `${input.runId}:${input.type}`,
        createdAt: now,
        updatedAt: now,
      };
      state.stages = [
        ...state.stages.filter((candidate) => candidate.stageId !== stage.stageId),
        stage,
      ].sort((a, b) => a.order - b.order);
      await writeRunState(input.runId, state);
      return stage;
    },

    async getStage(stageId) {
      const row = await getRunRow(runIdFromStageId(stageId));
      if (!row) return null;
      return stagesForRow(row).find((stage) => stage.stageId === stageId) ?? null;
    },

    async updateStage(stageId, patch) {
      const runId = runIdFromStageId(stageId);
      const { row, state } = await requireRunState(runId);
      const current = stagesForRow(row).find((stage) => stage.stageId === stageId);
      if (!current) throw new Error(`generation stage not found: ${stageId}`);
      const next: GenerationStage = {
        ...current,
        ...patch,
        stageId: current.stageId,
        runId: current.runId,
        createdAt: current.createdAt,
        updatedAt: new Date().toISOString(),
      };
      const baseStages = state.stages.length ? state.stages : syntheticStages(row);
      state.stages = baseStages
        .map((stage) => (stage.stageId === stageId ? next : stage))
        .sort((a, b) => a.order - b.order);
      await writeRunState(runId, state);
      return next;
    },

    async listStagesForRun(runId) {
      const row = await getRunRow(runId);
      return row ? stagesForRow(row) : [];
    },

    async saveStageItem(input) {
      const now = new Date().toISOString();
      const runId = runIdFromStageId(input.stageId);
      const { state } = await requireRunState(runId);
      const item: GenerationStageItem = {
        ...input,
        itemId: `${input.stageId}:item:${randomUUID()}`,
        createdAt: now,
        updatedAt: now,
      };
      state.stageItems = [...state.stageItems, item];
      await writeRunState(runId, state);
      return item;
    },

    async getStageItem(itemId) {
      const stageId = stageIdFromItemId(itemId);
      const row = await getRunRow(runIdFromStageId(stageId));
      if (!row) return null;
      return parseRunState(row.gates).stageItems.find((item) => item.itemId === itemId) ?? null;
    },

    async updateStageItem(itemId, patch) {
      const stageId = stageIdFromItemId(itemId);
      const runId = runIdFromStageId(stageId);
      const { state } = await requireRunState(runId);
      const current = state.stageItems.find((item) => item.itemId === itemId);
      if (!current) throw new Error(`generation stage item not found: ${itemId}`);
      const next: GenerationStageItem = {
        ...current,
        ...patch,
        itemId: current.itemId,
        stageId: current.stageId,
        createdAt: current.createdAt,
        updatedAt: new Date().toISOString(),
      };
      state.stageItems = state.stageItems.map((item) =>
        item.itemId === itemId ? next : item
      );
      await writeRunState(runId, state);
      return next;
    },

    async listStageItemsForStage(stageId) {
      const row = await getRunRow(runIdFromStageId(stageId));
      if (!row) return [];
      return parseRunState(row.gates)
        .stageItems.filter((item) => item.stageId === stageId)
        .sort((a, b) => (a.createdAt > b.createdAt ? 1 : -1));
    },

    async saveStageArtifact(input) {
      const now = new Date().toISOString();
      const runId = input.runId || runIdFromStageId(input.stageId);
      const { state } = await requireRunState(runId);
      const artifact: GenerationStageArtifact = {
        ...input,
        artifactId: `${input.stageId}:artifact:${randomUUID()}`,
        createdAt: now,
      };
      state.stageArtifacts = [...state.stageArtifacts, artifact];
      await writeRunState(runId, state);
      return artifact;
    },

    async getStageArtifact(artifactId) {
      const stageId = stageIdFromArtifactId(artifactId);
      const row = await getRunRow(runIdFromStageId(stageId));
      if (!row) return null;
      return parseRunState(row.gates)
        .stageArtifacts.find((artifact) => artifact.artifactId === artifactId) ?? null;
    },
  };
}

// ---------------------------------------------------------------------------
// File-based implementation (offline unit tests)
// ---------------------------------------------------------------------------

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
        runId: randomUUID(),
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
        stageId: randomUUID(),
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
        itemId: randomUUID(),
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

    async saveStageArtifact(input) {
      const now = new Date().toISOString();
      const artifact: GenerationStageArtifact = {
        ...input,
        artifactId: randomUUID(),
        createdAt: now,
      };
      await writeJson(COLLECTIONS.stageArtifacts, artifact.artifactId, artifact);
      return artifact;
    },

    getStageArtifact: (artifactId) =>
      readJson<GenerationStageArtifact>(COLLECTIONS.stageArtifacts, artifactId),
  };
}

let _store: GenerationRunsStore | null = null;
export function getGenerationRunsStore(): GenerationRunsStore {
  // Production singleton: Postgres-backed via the service-role client.
  if (!_store) _store = createSupabaseGenerationRunsStore();
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
