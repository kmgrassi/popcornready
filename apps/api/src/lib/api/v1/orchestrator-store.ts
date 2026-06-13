// Persistence for the orchestrator tool-calling loop: the run header and its
// relational gates. A tool invocation is an `actions` row (see store.ts
// createAction); this file owns only orchestrator_runs + orchestrator_run_gates.
// Kept separate from the ~13k-line store.ts per the cohesive-feature-file rule;
// shared low-level mappers come from ./store-internal.

import { getServiceSupabase } from "../../supabase/clients";
import { ApiError } from "./errors";
import { iso, markedJson, throwOnError, unmarkedJson } from "./store-internal";

export type OrchestratorRunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "canceled";

export type OrchestratorGateStatus = "pending" | "reached" | "approved" | "rejected";

export interface OrchestratorRun {
  id: string;
  schemaVersion: "orchestrator_run.v1";
  projectId: string;
  status: OrchestratorRunStatus;
  inputSummary: string;
  budgetUsd?: number;
  spentUsd: number;
  error?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface OrchestratorRunGate {
  id: string;
  orchestratorRunId: string;
  stage: string;
  status: OrchestratorGateStatus;
  decidedByActionId?: string;
  decidedAt?: string;
  createdAt: string;
  updatedAt: string;
}

// A minimal projection of the run's actions — enough to rebuild the model's
// prior-results context on resume without coupling to store.ts's mapAction.
export interface RunActionSummary {
  id: string;
  tool: string;
  status: string;
  params: Record<string, unknown>;
  outputAssetIds: string[];
  jobIds: string[];
  error?: Record<string, unknown>;
  createdAt: string;
}

export interface CreateOrchestratorRunInput {
  projectId: string;
  inputSummary: string;
  budgetUsd?: number;
  /** Stage/tool names to pause before; [] (or omitted) = fully autonomous. */
  gates?: string[];
  status?: OrchestratorRunStatus;
}

export type UpdateOrchestratorRunPatch = Partial<
  Pick<OrchestratorRun, "status" | "spentUsd" | "error" | "startedAt" | "completedAt">
>;

interface OrchestratorRunRow {
  id: string;
  schema_version: "orchestrator_run.v1";
  project_id: string;
  status: OrchestratorRunStatus;
  input_summary: string;
  budget_usd: number | null;
  spent_usd: number;
  error: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface OrchestratorRunGateRow {
  id: string;
  orchestrator_run_id: string;
  stage: string;
  status: OrchestratorGateStatus;
  decided_by_action_id: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
}

interface RunActionRow {
  id: string;
  tool: string;
  status: string;
  params: Record<string, unknown> | null;
  output_asset_ids: string[] | null;
  job_ids: string[] | null;
  error: Record<string, unknown> | null;
  created_at: string;
}

function mapRun(row: OrchestratorRunRow): OrchestratorRun {
  const run: OrchestratorRun = {
    id: row.id,
    schemaVersion: "orchestrator_run.v1",
    projectId: row.project_id,
    status: row.status,
    inputSummary: row.input_summary,
    spentUsd: row.spent_usd ?? 0,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
  if (row.budget_usd != null) run.budgetUsd = row.budget_usd;
  const error = unmarkedJson(row.error);
  if (error) run.error = error;
  if (row.started_at) run.startedAt = iso(row.started_at);
  if (row.completed_at) run.completedAt = iso(row.completed_at);
  return run;
}

function mapGate(row: OrchestratorRunGateRow): OrchestratorRunGate {
  const gate: OrchestratorRunGate = {
    id: row.id,
    orchestratorRunId: row.orchestrator_run_id,
    stage: row.stage,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
  if (row.decided_by_action_id) gate.decidedByActionId = row.decided_by_action_id;
  if (row.decided_at) gate.decidedAt = iso(row.decided_at);
  return gate;
}

function mapRunAction(row: RunActionRow): RunActionSummary {
  const summary: RunActionSummary = {
    id: row.id,
    tool: row.tool,
    status: row.status,
    params: unmarkedJson(row.params) ?? {},
    outputAssetIds: row.output_asset_ids ?? [],
    jobIds: row.job_ids ?? [],
    createdAt: iso(row.created_at),
  };
  const error = unmarkedJson(row.error);
  if (error) summary.error = error;
  return summary;
}

export async function createOrchestratorRun(
  input: CreateOrchestratorRunInput
): Promise<OrchestratorRun> {
  const db = getServiceSupabase();
  const now = new Date().toISOString();
  const inserted = await db
    .from("orchestrator_runs")
    .insert({
      schema_version: "orchestrator_run.v1",
      project_id: input.projectId,
      status: input.status ?? "queued",
      input_summary: input.inputSummary,
      budget_usd: input.budgetUsd ?? null,
      spent_usd: 0,
      created_at: now,
      updated_at: now,
    })
    .select("*")
    .single();
  throwOnError(inserted.error, "createOrchestratorRun");
  const run = mapRun(inserted.data as OrchestratorRunRow);

  const stages = [...new Set((input.gates ?? []).filter((stage) => stage.trim().length > 0))];
  if (stages.length > 0) {
    const { error } = await db.from("orchestrator_run_gates").insert(
      stages.map((stage) => ({
        orchestrator_run_id: run.id,
        stage,
        status: "pending",
        created_at: now,
        updated_at: now,
      }))
    );
    throwOnError(error, "createOrchestratorRun gates");
  }
  return run;
}

export async function getOrchestratorRun(runId: string): Promise<OrchestratorRun> {
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("orchestrator_runs")
    .select("*")
    .eq("id", runId)
    .maybeSingle();
  throwOnError(error, "getOrchestratorRun");
  if (!data) throw new ApiError("not_found", `Orchestrator run not found: ${runId}`);
  return mapRun(data as OrchestratorRunRow);
}

export async function updateOrchestratorRun(
  runId: string,
  patch: UpdateOrchestratorRunPatch
): Promise<OrchestratorRun> {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.spentUsd !== undefined) row.spent_usd = patch.spentUsd;
  if (patch.error !== undefined) {
    row.error = markedJson("orchestrator_error.v1", patch.error) ?? null;
  }
  if (patch.startedAt !== undefined) row.started_at = patch.startedAt;
  if (patch.completedAt !== undefined) row.completed_at = patch.completedAt;

  const db = getServiceSupabase();
  const { data, error } = await db
    .from("orchestrator_runs")
    .update(row)
    .eq("id", runId)
    .select("*")
    .single();
  throwOnError(error, `updateOrchestratorRun ${runId}`);
  return mapRun(data as OrchestratorRunRow);
}

export async function listRunGates(runId: string): Promise<OrchestratorRunGate[]> {
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("orchestrator_run_gates")
    .select("*")
    .eq("orchestrator_run_id", runId)
    .order("created_at", { ascending: true });
  throwOnError(error, "listRunGates");
  return ((data as OrchestratorRunGateRow[]) ?? []).map(mapGate);
}

// Mark the pending gate for a stage as reached (the loop arrived at it). Returns
// the gate, or null if there is no pending gate for that stage.
export async function markGateReached(
  runId: string,
  stage: string
): Promise<OrchestratorRunGate | null> {
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("orchestrator_run_gates")
    .update({ status: "reached", updated_at: new Date().toISOString() })
    .eq("orchestrator_run_id", runId)
    .eq("stage", stage)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();
  throwOnError(error, "markGateReached");
  return data ? mapGate(data as OrchestratorRunGateRow) : null;
}

export async function resolveGate(
  gateId: string,
  status: "approved" | "rejected",
  decidedByActionId?: string
): Promise<OrchestratorRunGate> {
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("orchestrator_run_gates")
    .update({
      status,
      decided_at: new Date().toISOString(),
      decided_by_action_id: decidedByActionId ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", gateId)
    .select("*")
    .single();
  throwOnError(error, `resolveGate ${gateId}`);
  return mapGate(data as OrchestratorRunGateRow);
}

// The run's invocations in order — used to rebuild the model's prior-results
// context when a parked run resumes.
export async function listRunActions(runId: string): Promise<RunActionSummary[]> {
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("actions")
    .select("id, tool, status, params, output_asset_ids, job_ids, error, created_at")
    .eq("orchestrator_run_id", runId)
    .order("created_at", { ascending: true });
  throwOnError(error, "listRunActions");
  return ((data as RunActionRow[]) ?? []).map(mapRunAction);
}
