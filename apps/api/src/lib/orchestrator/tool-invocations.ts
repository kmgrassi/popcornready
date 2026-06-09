import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";

import { localDir } from "../api/v1/store";

export type ToolInvocationStatus =
  | "requested"
  | "running"
  | "waiting_for_job"
  | "waiting_for_approval"
  | "succeeded"
  | "failed"
  | "cancelled";

export type OrchestratorRunStatus =
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled";

export type OrchestratorTurnTerminalReason =
  | "tool_requested"
  | "waiting"
  | "done"
  | "error";

export type ToolName =
  | "create_or_load_brief"
  | "develop_story_blueprint"
  | "draft_script"
  | "plan_shots"
  | "plan_visual_anchors"
  | "generate_anchor"
  | "generate_storyboard"
  | "generate_keyframe"
  | "generate_clip"
  | "generate_audio"
  | "assemble_timeline"
  | "critique_timeline"
  | "request_approval"
  | "export_video";

export type ToolErrorKind =
  | "precondition_unmet"
  | "invalid_input"
  | "provider_quota"
  | "provider_failed"
  | "budget_exceeded"
  | "approval_rejected"
  | "policy_violation"
  | "timeout";

export interface SuggestedToolCall {
  tool: ToolName;
  inputHint: Record<string, unknown>;
}

export interface PreconditionMiss {
  requirement: string;
  because: string;
  satisfyWith: SuggestedToolCall;
}

export interface ToolError {
  kind: ToolErrorKind;
  message: string;
  recoverable: boolean;
  retryAfterSec?: number;
  unmetRequirements?: PreconditionMiss[];
  suggestedNextTools?: SuggestedToolCall[];
  details?: Record<string, unknown>;
}

export type ToolCallResult =
  | {
      status: "succeeded";
      resourceIds: string[];
      artifactIds?: string[];
      costUsd?: number;
      output?: unknown;
    }
  | {
      status: "accepted";
      jobId: string;
      resumesWhen: "job_terminal";
      estimatedCostUsd?: number;
    }
  | {
      status: "waiting_for_approval";
      gateId: string;
      resumesWhen: "approval_terminal";
      previewArtifactIds: string[];
    }
  | {
      status: "failed";
      error: ToolError;
    };

export interface OrchestratorRun {
  id: string;
  projectId: string;
  generationRunId?: string;
  status: OrchestratorRunStatus;
  currentTurnId?: string;
  waitingOn?: {
    kind: "tool_job" | "approval_gate";
    id: string;
  };
  budget?: {
    maxUsd?: number;
    spentUsd: number;
    proposedUsd: number;
  };
  createdAt: string;
  updatedAt: string;
}

export interface OrchestratorTurn {
  id: string;
  orchestratorRunId: string;
  inputSummary: string;
  model: string;
  toolInvocationIds: string[];
  terminalReason: OrchestratorTurnTerminalReason;
  createdAt: string;
}

export interface ToolInvocation {
  id: string;
  orchestratorRunId: string;
  turnId: string;
  toolName: ToolName;
  input: unknown;
  status: ToolInvocationStatus;
  jobId?: string;
  gateId?: string;
  result?: ToolCallResult;
  error?: ToolError;
  createdAt: string;
  updatedAt: string;
}

export type CreateOrchestratorRunInput = Omit<
  OrchestratorRun,
  "id" | "status" | "createdAt" | "updatedAt"
> &
  Partial<Pick<OrchestratorRun, "status">>;

export type CreateOrchestratorTurnInput = Omit<
  OrchestratorTurn,
  "id" | "toolInvocationIds" | "createdAt"
>;

export interface CreateToolInvocationInput {
  orchestratorRunId: string;
  turnId: string;
  toolName: ToolName;
  input: unknown;
  status?: Extract<ToolInvocationStatus, "requested" | "running">;
}

export type UpdateOrchestratorRunPatch = Partial<
  Omit<OrchestratorRun, "id" | "projectId" | "createdAt">
>;

export type UpdateOrchestratorTurnPatch = Partial<
  Omit<OrchestratorTurn, "id" | "orchestratorRunId" | "createdAt">
>;

export type CompleteToolInvocationInput =
  | {
      status: "succeeded";
      result: Extract<ToolCallResult, { status: "succeeded" }>;
    }
  | {
      status: "failed";
      result: Extract<ToolCallResult, { status: "failed" }>;
    }
  | {
      status: "cancelled";
      error?: ToolError;
    };

interface OrchestratorDb {
  runs: OrchestratorRun[];
  turns: OrchestratorTurn[];
  invocations: ToolInvocation[];
}

function dbFile(): string {
  return path.join(localDir(), "orchestrator-tool-invocations.json");
}

async function readDb(): Promise<OrchestratorDb> {
  try {
    const raw = await fs.readFile(dbFile(), "utf8");
    const parsed = JSON.parse(raw) as Partial<OrchestratorDb>;
    return {
      runs: parsed.runs ?? [],
      turns: parsed.turns ?? [],
      invocations: parsed.invocations ?? [],
    };
  } catch {
    return { runs: [], turns: [], invocations: [] };
  }
}

async function writeDb(db: OrchestratorDb): Promise<void> {
  await fs.mkdir(localDir(), { recursive: true });
  await fs.writeFile(dbFile(), JSON.stringify(db, null, 2), "utf8");
}

let writeChain: Promise<unknown> = Promise.resolve();

function mutate<T>(fn: (db: OrchestratorDb) => T | Promise<T>): Promise<T> {
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

function findRun(db: OrchestratorDb, runId: string): OrchestratorRun {
  const run = db.runs.find((candidate) => candidate.id === runId);
  if (!run) throw new Error(`Orchestrator run not found: ${runId}`);
  return run;
}

function findTurn(db: OrchestratorDb, turnId: string): OrchestratorTurn {
  const turn = db.turns.find((candidate) => candidate.id === turnId);
  if (!turn) throw new Error(`Orchestrator turn not found: ${turnId}`);
  return turn;
}

function findInvocation(
  db: OrchestratorDb,
  invocationId: string
): ToolInvocation {
  const invocation = db.invocations.find(
    (candidate) => candidate.id === invocationId
  );
  if (!invocation) throw new Error(`Tool invocation not found: ${invocationId}`);
  return invocation;
}

function isTerminalStatus(status: ToolInvocationStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function clearRunWaitIfMatching(
  run: OrchestratorRun,
  kind: NonNullable<OrchestratorRun["waitingOn"]>["kind"],
  id: string
): void {
  if (run.waitingOn?.kind === kind && run.waitingOn.id === id) {
    delete run.waitingOn;
    if (run.status === "waiting") {
      run.status = "running";
    }
  }
}

export function createOrchestratorRun(
  input: CreateOrchestratorRunInput
): Promise<OrchestratorRun> {
  return mutate((db) => {
    const now = new Date().toISOString();
    const run: OrchestratorRun = {
      ...input,
      id: randomUUID(),
      status: input.status ?? "running",
      createdAt: now,
      updatedAt: now,
    };
    db.runs.push(run);
    return run;
  });
}

export function getOrchestratorRun(
  runId: string
): Promise<OrchestratorRun | null> {
  return readDb().then(
    (db) => db.runs.find((candidate) => candidate.id === runId) ?? null
  );
}

export function updateOrchestratorRun(
  runId: string,
  patch: UpdateOrchestratorRunPatch
): Promise<OrchestratorRun> {
  return mutate((db) => {
    const run = findRun(db, runId);
    Object.assign(run, patch, { updatedAt: new Date().toISOString() });
    return run;
  });
}

export function createOrchestratorTurn(
  input: CreateOrchestratorTurnInput
): Promise<OrchestratorTurn> {
  return mutate((db) => {
    const run = findRun(db, input.orchestratorRunId);
    const now = new Date().toISOString();
    const turn: OrchestratorTurn = {
      ...input,
      id: randomUUID(),
      toolInvocationIds: [],
      createdAt: now,
    };
    db.turns.push(turn);
    run.currentTurnId = turn.id;
    run.updatedAt = now;
    return turn;
  });
}

export async function getOrchestratorTurn(
  turnId: string
): Promise<OrchestratorTurn | null> {
  const db = await readDb();
  return db.turns.find((candidate) => candidate.id === turnId) ?? null;
}

export function updateOrchestratorTurn(
  turnId: string,
  patch: UpdateOrchestratorTurnPatch
): Promise<OrchestratorTurn> {
  return mutate((db) => {
    const turn = findTurn(db, turnId);
    Object.assign(turn, patch);
    return turn;
  });
}

export function createToolInvocation(
  input: CreateToolInvocationInput
): Promise<ToolInvocation> {
  return mutate((db) => {
    const run = findRun(db, input.orchestratorRunId);
    const turn = findTurn(db, input.turnId);
    if (turn.orchestratorRunId !== run.id) {
      throw new Error(`Turn ${turn.id} does not belong to run ${run.id}`);
    }

    const now = new Date().toISOString();
    const invocation: ToolInvocation = {
      ...input,
      id: randomUUID(),
      status: input.status ?? "requested",
      createdAt: now,
      updatedAt: now,
    };
    db.invocations.push(invocation);
    turn.toolInvocationIds.push(invocation.id);
    turn.terminalReason = "tool_requested";
    run.currentTurnId = turn.id;
    run.updatedAt = now;
    return invocation;
  });
}

export async function getToolInvocation(
  invocationId: string
): Promise<ToolInvocation | null> {
  const db = await readDb();
  return (
    db.invocations.find((candidate) => candidate.id === invocationId) ?? null
  );
}

export function markToolInvocationWaitingForJob(
  invocationId: string,
  result: Extract<ToolCallResult, { status: "accepted" }>
): Promise<ToolInvocation> {
  return mutate((db) => {
    const invocation = findInvocation(db, invocationId);
    const run = findRun(db, invocation.orchestratorRunId);
    const turn = findTurn(db, invocation.turnId);
    const now = new Date().toISOString();

    invocation.status = "waiting_for_job";
    invocation.jobId = result.jobId;
    invocation.result = result;
    invocation.updatedAt = now;
    turn.terminalReason = "waiting";
    run.status = "waiting";
    run.waitingOn = { kind: "tool_job", id: result.jobId };
    run.updatedAt = now;
    return invocation;
  });
}

export function markToolInvocationWaitingForApproval(
  invocationId: string,
  result: Extract<ToolCallResult, { status: "waiting_for_approval" }>
): Promise<ToolInvocation> {
  return mutate((db) => {
    const invocation = findInvocation(db, invocationId);
    const run = findRun(db, invocation.orchestratorRunId);
    const turn = findTurn(db, invocation.turnId);
    const now = new Date().toISOString();

    invocation.status = "waiting_for_approval";
    invocation.gateId = result.gateId;
    invocation.result = result;
    invocation.updatedAt = now;
    turn.terminalReason = "waiting";
    run.status = "waiting";
    run.waitingOn = { kind: "approval_gate", id: result.gateId };
    run.updatedAt = now;
    return invocation;
  });
}

export function completeToolInvocation(
  invocationId: string,
  input: CompleteToolInvocationInput
): Promise<ToolInvocation> {
  return mutate((db) => {
    const invocation = findInvocation(db, invocationId);
    if (isTerminalStatus(invocation.status)) {
      throw new Error(`Tool invocation is already terminal: ${invocationId}`);
    }

    const run = findRun(db, invocation.orchestratorRunId);
    const turn = findTurn(db, invocation.turnId);
    const now = new Date().toISOString();

    invocation.status = input.status;
    invocation.updatedAt = now;
    if (input.status === "cancelled") {
      invocation.error = input.error;
    } else {
      invocation.result = input.result;
      if (input.status === "failed") {
        invocation.error = input.result.error;
      }
    }

    if (invocation.jobId) {
      clearRunWaitIfMatching(run, "tool_job", invocation.jobId);
    }
    if (invocation.gateId) {
      clearRunWaitIfMatching(run, "approval_gate", invocation.gateId);
    }

    turn.terminalReason = input.status === "succeeded" ? "done" : "error";
    run.updatedAt = now;
    return invocation;
  });
}

export async function listToolInvocationsForRun(
  orchestratorRunId: string
): Promise<ToolInvocation[]> {
  const db = await readDb();
  return db.invocations.filter(
    (invocation) => invocation.orchestratorRunId === orchestratorRunId
  );
}

export async function listWaitingToolInvocations(): Promise<ToolInvocation[]> {
  const db = await readDb();
  return db.invocations.filter(
    (invocation) =>
      invocation.status === "waiting_for_job" ||
      invocation.status === "waiting_for_approval"
  );
}

export async function findToolInvocationWaitingOn(
  waitingOn: NonNullable<OrchestratorRun["waitingOn"]>
): Promise<ToolInvocation | null> {
  const db = await readDb();
  return (
    db.invocations.find((invocation) => {
      if (waitingOn.kind === "tool_job") {
        return (
          invocation.status === "waiting_for_job" &&
          invocation.jobId === waitingOn.id
        );
      }
      return (
        invocation.status === "waiting_for_approval" &&
        invocation.gateId === waitingOn.id
      );
    }) ?? null
  );
}

export async function listRunsReadyToResume(): Promise<OrchestratorRun[]> {
  const db = await readDb();
  return db.runs.filter((run) => {
    if (run.status !== "running" || run.currentTurnId == null) return false;

    const turn = db.turns.find((candidate) => candidate.id === run.currentTurnId);
    if (!turn) return false;
    if (turn.terminalReason !== "done" && turn.terminalReason !== "error") {
      return false;
    }

    return turn.toolInvocationIds.every((invocationId) => {
      const invocation = db.invocations.find(
        (candidate) => candidate.id === invocationId
      );
      return invocation != null && isTerminalStatus(invocation.status);
    });
  });
}
