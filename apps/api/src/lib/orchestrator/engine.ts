// The autonomous orchestrator engine: the persistent, gated, multi-turn loop on
// top of the single-turn primitives (the model + executeRegisteredTool). A run is
// durable state (orchestrator_runs + its actions), not a live process — each call
// loads the run, drives turns until it parks (async job / approval gate) or
// finishes, then exits. Re-entry (resume) is the same loop re-applied. Deliberately
// calls model + executeRegisteredTool directly (rather than runToolLoopTurn) so it
// can pause BEFORE a gated tool executes.
//
// All side effects are injectable (store, jobs, model, registry) so the loop is
// unit-testable with fakes — no DB, no network.

import { createAction } from "@/lib/api/v1/store";
import {
  getOrchestratorRun,
  listRunActions,
  listRunGates,
  markGateReached,
  updateOrchestratorRun,
  type OrchestratorRun,
  type OrchestratorRunGate,
  type RunActionSummary,
  type UpdateOrchestratorRunPatch,
} from "@/lib/api/v1/orchestrator-store";
import { createDefaultToolRegistry } from "@/lib/orchestrator-tools/default-registry";
import { toOrchestratorRegistry } from "@/lib/orchestrator-tools/to-orchestrator-registry";
import { agentApiStore } from "@/lib/agent-api/jobs";
import { orchestratorModel, type OrchestratorModel } from "./model";
import { executeRegisteredTool, type ToolRegistry } from "./registry";
import type { ToolCallResult } from "./types";

const DEFAULT_MAX_TURNS = 50;

export interface InvocationRecord {
  projectId: string;
  orchestratorRunId: string;
  tool: string;
  status: "applied" | "failed" | "running";
  params: Record<string, unknown>;
  outputAssetIds: string[];
  jobIds: string[];
  costUsd?: number;
  error?: Record<string, unknown>;
}

// The persistence surface the loop depends on. The real implementation is
// defaultEngineStore(); tests inject a fake.
export interface OrchestratorEngineStore {
  getOrchestratorRun(runId: string): Promise<OrchestratorRun>;
  updateOrchestratorRun(
    runId: string,
    patch: UpdateOrchestratorRunPatch
  ): Promise<OrchestratorRun>;
  listRunGates(runId: string): Promise<OrchestratorRunGate[]>;
  markGateReached(runId: string, stage: string): Promise<OrchestratorRunGate | null>;
  listRunActions(runId: string): Promise<RunActionSummary[]>;
  recordInvocation(input: InvocationRecord): Promise<void>;
}

export interface JobStatusReader {
  getJob(jobId: string): Promise<{ status: string } | null | undefined>;
}

export interface EngineDeps {
  /** The throwaway/owning workspace; tools execute in its scope. */
  workspaceId: string;
  store?: OrchestratorEngineStore;
  model?: OrchestratorModel;
  /** Bridged orchestrator registry; defaults to the wired tools only. */
  registry?: ToolRegistry;
  jobs?: JobStatusReader;
  maxTurns?: number;
}

export function defaultEngineStore(): OrchestratorEngineStore {
  return {
    getOrchestratorRun,
    updateOrchestratorRun,
    listRunGates,
    markGateReached,
    listRunActions,
    async recordInvocation(input) {
      await createAction({
        projectId: input.projectId,
        orchestratorRunId: input.orchestratorRunId,
        tool: input.tool,
        status: input.status,
        params: input.params,
        outputAssetIds: input.outputAssetIds,
        jobIds: input.jobIds,
        estimatedCostUsd: input.costUsd,
        error: input.error,
      });
    },
  };
}

let cachedRegistry: ToolRegistry | undefined;
function defaultRegistry(): ToolRegistry {
  if (!cachedRegistry) {
    cachedRegistry = toOrchestratorRegistry(createDefaultToolRegistry());
  }
  return cachedRegistry;
}

function nowIso(): string {
  return new Date().toISOString();
}

function resolved(deps: EngineDeps) {
  return {
    store: deps.store ?? defaultEngineStore(),
    model: deps.model ?? orchestratorModel,
    registry: deps.registry ?? defaultRegistry(),
    jobs: deps.jobs ?? { getJob: (id: string) => agentApiStore.getJob(id) },
    maxTurns: deps.maxTurns ?? DEFAULT_MAX_TURNS,
    workspaceId: deps.workspaceId,
  };
}

// Start a run and drive it to a terminal/parked state.
export async function runOrchestratorToCompletion(
  runId: string,
  deps: EngineDeps
): Promise<OrchestratorRun> {
  const r = resolved(deps);
  let run = await r.store.getOrchestratorRun(runId);
  if (run.status === "queued") {
    run = await r.store.updateOrchestratorRun(runId, {
      status: "running",
      startedAt: nowIso(),
    });
  }
  if (run.status !== "running") return run;
  return driveGuarded(run, r);
}

// Re-enter a parked run. If it's waiting on an async job, advance only once the
// job is terminal; the job's own worker calls this on completion (no polling in
// the happy path), and a sweeper calls it for crash recovery.
export async function resumeOrchestratorRun(
  runId: string,
  deps: EngineDeps
): Promise<OrchestratorRun> {
  const r = resolved(deps);
  let run = await r.store.getOrchestratorRun(runId);
  if (run.status === "running") return driveGuarded(run, r);
  if (run.status !== "waiting") return run;

  // Determine the parking job (latest in-flight action carrying a job id).
  const actions = await r.store.listRunActions(runId);
  const parkingJobId = [...actions]
    .reverse()
    .find((action) => action.status === "running" && action.jobIds.length > 0)
    ?.jobIds.at(-1);

  if (parkingJobId) {
    const job = await r.jobs.getJob(parkingJobId);
    if (!job) return run; // unknown job — leave parked for the sweeper
    if (job.status === "failed" || job.status === "canceled") {
      return finish(run, "failed", r, {
        kind: "provider_failed",
        message: `parking job ${parkingJobId} ended ${job.status}`,
      });
    }
    if (job.status !== "succeeded") return run; // still running — stay parked
  }
  // Not job-parked (or job done) → it's a gate the caller has resolved. Continue.
  run = await r.store.updateOrchestratorRun(runId, { status: "running" });
  return driveGuarded(run, r);
}

type Resolved = ReturnType<typeof resolved>;

// Drive the loop, but guarantee a terminal run: any uncaught error (a model/store
// failure that driveLoop doesn't already convert into a failed result) marks the
// run 'failed' with the error before rethrowing, so it is never left 'running'.
async function driveGuarded(run: OrchestratorRun, r: Resolved): Promise<OrchestratorRun> {
  try {
    return await driveLoop(run, r);
  } catch (err) {
    const error = {
      kind: "provider_failed",
      message: err instanceof Error ? err.message : String(err),
      recoverable: false,
    };
    try {
      await finish(run, "failed", r, error);
    } catch {
      // best-effort; surface the original error regardless.
    }
    throw err;
  }
}

async function driveLoop(run: OrchestratorRun, r: Resolved): Promise<OrchestratorRun> {
  for (let turn = 0; turn < r.maxTurns; turn += 1) {
    if (run.budgetUsd != null && run.spentUsd >= run.budgetUsd) {
      return finish(run, "failed", r, {
        kind: "budget_exceeded",
        message: `spent ${run.spentUsd} >= budget ${run.budgetUsd}`,
      });
    }

    const prior = await r.store.listRunActions(run.id);
    const priorResults = prior.map((action) => ({
      tool: action.tool,
      status: action.status,
      outputAssetIds: action.outputAssetIds,
    }));

    const decision = await r.model({
      projectId: run.projectId,
      inputSummary: run.inputSummary,
      priorResults,
      registry: r.registry,
    });

    if (decision.type === "done") {
      return finish(run, "succeeded", r);
    }

    // Gate handling. A user-rejected stage must NOT run and must NOT park forever:
    // record a recoverable failure so the rejection lands in priorResults and the
    // model picks a different step. A pending/reached gate pauses for the user; an
    // approved gate falls through and executes.
    const gates = await r.store.listRunGates(run.id);
    const gate = gates.find((g) => g.stage === decision.toolName);
    if (gate && gate.status === "rejected") {
      await r.store.recordInvocation({
        projectId: run.projectId,
        orchestratorRunId: run.id,
        tool: decision.toolName,
        status: "failed",
        params: decision.input,
        outputAssetIds: [],
        jobIds: [],
        error: {
          kind: "approval_rejected",
          message: `The ${decision.toolName} gate was rejected; choose a different step.`,
          recoverable: true,
        },
      });
      run = await r.store.getOrchestratorRun(run.id);
      continue; // next turn — the model now sees the rejection
    }
    if (gate && gate.status !== "approved") {
      if (gate.status === "pending") {
        await r.store.markGateReached(run.id, decision.toolName);
      }
      return park(run, r);
    }

    // A wired tool may THROW (DB/provider exception) instead of returning a
    // ToolCallResult. Catch it so the run reaches a terminal 'failed' state with a
    // persisted error rather than being left stuck 'running'.
    let result: ToolCallResult;
    try {
      result = await executeRegisteredTool({
        registry: r.registry,
        toolName: decision.toolName,
        input: decision.input,
        context: {
          workspaceId: r.workspaceId,
          projectId: run.projectId,
          orchestratorRunId: run.id,
          actorId: "orchestrator",
        },
      });
    } catch (err) {
      const error = {
        kind: "provider_failed",
        message: err instanceof Error ? err.message : String(err),
        recoverable: false,
      };
      await r.store.recordInvocation({
        projectId: run.projectId,
        orchestratorRunId: run.id,
        tool: decision.toolName,
        status: "failed",
        params: decision.input,
        outputAssetIds: [],
        jobIds: [],
        error,
      });
      return finish(run, "failed", r, error);
    }

    await r.store.recordInvocation({
      projectId: run.projectId,
      orchestratorRunId: run.id,
      tool: decision.toolName,
      status:
        result.status === "succeeded"
          ? "applied"
          : result.status === "failed"
            ? "failed"
            : "running",
      params: decision.input,
      outputAssetIds: result.status === "succeeded" ? result.resourceIds : [],
      jobIds: result.status === "accepted" ? [result.jobId] : [],
      costUsd: result.status === "succeeded" ? result.costUsd : undefined,
      error: result.status === "failed" ? { ...result.error } : undefined,
    });

    if (result.status === "succeeded" && result.costUsd) {
      run = await r.store.updateOrchestratorRun(run.id, {
        spentUsd: run.spentUsd + result.costUsd,
      });
    }

    if (result.status === "accepted" || result.status === "waiting_for_approval") {
      return park(run, r); // parked on a job / approval gate
    }
    if (result.status === "failed" && !result.error.recoverable) {
      return finish(run, "failed", r, { ...result.error });
    }
    // succeeded, or a recoverable failure the model can self-heal from → keep going.
    run = await r.store.getOrchestratorRun(run.id);
  }

  return finish(run, "failed", r, {
    kind: "timeout",
    message: `exceeded ${r.maxTurns} turns`,
  });
}

async function finish(
  run: OrchestratorRun,
  status: "succeeded" | "failed",
  r: Resolved,
  error?: Record<string, unknown>
): Promise<OrchestratorRun> {
  return r.store.updateOrchestratorRun(run.id, {
    status,
    completedAt: nowIso(),
    ...(error ? { error } : {}),
  });
}

async function park(run: OrchestratorRun, r: Resolved): Promise<OrchestratorRun> {
  return r.store.updateOrchestratorRun(run.id, { status: "waiting" });
}
