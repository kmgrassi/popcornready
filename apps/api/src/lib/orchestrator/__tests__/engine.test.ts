import assert from "node:assert/strict";
import test from "node:test";

import type {
  OrchestratorRun,
  OrchestratorRunGate,
  RunActionSummary,
  UpdateOrchestratorRunPatch,
} from "@/lib/api/v1/orchestrator-store";
import {
  resumeOrchestratorRun,
  runOrchestratorToCompletion,
  type EngineDeps,
  type InvocationRecord,
  type OrchestratorEngineStore,
} from "../engine";
import type { ToolCallResult, ToolName } from "../types";
import type { OrchestratorModel } from "../model";
import type { ToolRegistry } from "../registry";

// ---------- fakes (no DB, no network) ----------

function runFixture(over: Partial<OrchestratorRun> = {}): OrchestratorRun {
  return {
    id: "run1",
    schemaVersion: "orchestrator_run.v1",
    projectId: "proj1",
    status: "queued",
    inputSummary: "make a 15s video about a skateboarding puppy",
    spentUsd: 0,
    createdAt: "t0",
    updatedAt: "t0",
    ...over,
  };
}

function gateFixture(
  stage: string,
  status: OrchestratorRunGate["status"] = "pending"
): OrchestratorRunGate {
  return {
    id: `gate_${stage}`,
    orchestratorRunId: "run1",
    stage,
    status,
    createdAt: "t0",
    updatedAt: "t0",
  };
}

class FakeStore implements OrchestratorEngineStore {
  run: OrchestratorRun;
  gates: OrchestratorRunGate[];
  actions: RunActionSummary[] = [];

  constructor(run: OrchestratorRun, gates: OrchestratorRunGate[] = []) {
    this.run = run;
    this.gates = gates;
  }
  async getOrchestratorRun() {
    return { ...this.run };
  }
  async updateOrchestratorRun(_id: string, patch: UpdateOrchestratorRunPatch) {
    this.run = { ...this.run, ...patch };
    return { ...this.run };
  }
  async listRunGates() {
    return this.gates.map((g) => ({ ...g }));
  }
  async markGateReached(_id: string, stage: string) {
    const g = this.gates.find((x) => x.stage === stage && x.status === "pending");
    if (!g) return null;
    g.status = "reached";
    return { ...g };
  }
  async listRunActions() {
    return this.actions.map((a) => ({ ...a }));
  }
  async recordInvocation(input: InvocationRecord) {
    this.actions.push({
      id: `a${this.actions.length}`,
      tool: input.tool,
      status: input.status,
      params: input.params,
      outputAssetIds: input.outputAssetIds,
      jobIds: input.jobIds,
      createdAt: `t${this.actions.length + 1}`,
    });
  }
  async markInvocation(
    actionId: string,
    patch: { status: "applied" | "failed"; outputAssetIds?: string[] }
  ) {
    const action = this.actions.find((a) => a.id === actionId);
    if (!action) return;
    action.status = patch.status;
    if (patch.outputAssetIds) action.outputAssetIds = patch.outputAssetIds;
  }
}

function fakeRegistry(
  handlers: Partial<Record<ToolName, () => ToolCallResult>>
): ToolRegistry {
  const map: ToolRegistry = new Map();
  for (const [name, fn] of Object.entries(handlers)) {
    map.set(name as ToolName, {
      name: name as ToolName,
      description: "",
      inputSchema: {},
      outputSchema: {},
      requiredResourceIds: [],
      mode: "sync",
      estimateCostUsd: () => undefined,
      execute: async () => fn!(),
    });
  }
  return map;
}

// A model that replays a fixed list of decisions in order.
function scriptedModel(
  decisions: Array<
    | { type: "tool_call"; toolName: ToolName; input?: Record<string, unknown> }
    | { type: "done" }
  >
): { model: OrchestratorModel; calls: unknown[] } {
  const calls: unknown[] = [];
  let i = 0;
  const model: OrchestratorModel = async (input) => {
    calls.push(input.priorResults);
    const d = decisions[Math.min(i, decisions.length - 1)];
    i += 1;
    if (d.type === "done") return { type: "done", summary: "done", model: "mock" };
    return { type: "tool_call", toolName: d.toolName, input: d.input ?? {}, model: "mock" };
  };
  return { model, calls };
}

function deps(store: FakeStore, model: OrchestratorModel, registry: ToolRegistry, extra: Partial<EngineDeps> = {}): EngineDeps {
  return { workspaceId: "ws1", store, model, registry, ...extra };
}

const ok = (resourceIds: string[] = [], costUsd?: number): ToolCallResult => ({
  status: "succeeded",
  resourceIds,
  ...(costUsd != null ? { costUsd } : {}),
});

// ---------- tests ----------

test("drives tool→tool→done and persists one action per executed tool", async () => {
  const store = new FakeStore(runFixture());
  const { model } = scriptedModel([
    { type: "tool_call", toolName: "create_or_load_brief" },
    { type: "tool_call", toolName: "plan_shots" },
    { type: "done" },
  ]);
  const registry = fakeRegistry({
    create_or_load_brief: () => ok(["asset_brief"]),
    plan_shots: () => ok([]),
  });

  const run = await runOrchestratorToCompletion("run1", deps(store, model, registry));

  assert.equal(run.status, "succeeded");
  assert.equal(store.actions.length, 2);
  assert.deepEqual(
    store.actions.map((a) => [a.tool, a.status]),
    [
      ["create_or_load_brief", "applied"],
      ["plan_shots", "applied"],
    ]
  );
});

test("reconstructs priorResults from persisted actions for each model turn", async () => {
  const store = new FakeStore(runFixture());
  const { model, calls } = scriptedModel([
    { type: "tool_call", toolName: "create_or_load_brief" },
    { type: "done" },
  ]);
  const registry = fakeRegistry({ create_or_load_brief: () => ok(["asset_brief"]) });

  await runOrchestratorToCompletion("run1", deps(store, model, registry));

  // First turn sees no prior actions; the second (which returns done) sees the brief.
  assert.deepEqual(calls[0], []);
  assert.deepEqual(calls[1], [
    { tool: "create_or_load_brief", status: "applied", outputAssetIds: ["asset_brief"] },
  ]);
});

test("parks on an accepted async job, then resumes to completion when the job succeeds", async () => {
  const store = new FakeStore(runFixture());
  const { model } = scriptedModel([
    { type: "tool_call", toolName: "generate_keyframe" },
    { type: "done" },
  ]);
  const registry = fakeRegistry({
    generate_keyframe: () => ({ status: "accepted", jobId: "job1", resumesWhen: "job_terminal" }),
  });

  const parked = await runOrchestratorToCompletion("run1", deps(store, model, registry));
  assert.equal(parked.status, "waiting");
  assert.equal(store.actions.length, 1);
  assert.deepEqual([store.actions[0].status, store.actions[0].jobIds], ["running", ["job1"]]);

  const resumed = await resumeOrchestratorRun(
    "run1",
    deps(store, model, registry, {
      jobs: { getJob: async () => ({ status: "succeeded", result: { assetIds: ["tile_1", "tile_2"] } }) },
    })
  );
  assert.equal(resumed.status, "succeeded");
  // the parking action is finalized with the assets its job produced
  assert.equal(store.actions[0].status, "applied");
  assert.deepEqual(store.actions[0].outputAssetIds, ["tile_1", "tile_2"]);
});

test("stays parked when the resume job is not yet terminal", async () => {
  const store = new FakeStore(runFixture());
  const { model } = scriptedModel([{ type: "tool_call", toolName: "generate_keyframe" }]);
  const registry = fakeRegistry({
    generate_keyframe: () => ({ status: "accepted", jobId: "job1", resumesWhen: "job_terminal" }),
  });
  await runOrchestratorToCompletion("run1", deps(store, model, registry));

  const stillParked = await resumeOrchestratorRun(
    "run1",
    deps(store, model, registry, { jobs: { getJob: async () => ({ status: "running" }) } })
  );
  assert.equal(stillParked.status, "waiting");
});

test("parks before a gated stage and resumes once the gate is approved", async () => {
  const store = new FakeStore(runFixture(), [gateFixture("create_or_load_brief")]);
  // Model wants the brief until one exists, then it's done.
  const model: OrchestratorModel = async ({ priorResults }) => {
    const hasBrief = (priorResults as Array<{ tool: string }>).some(
      (r) => r.tool === "create_or_load_brief"
    );
    return hasBrief
      ? { type: "done", summary: "done", model: "mock" }
      : { type: "tool_call", toolName: "create_or_load_brief", input: {}, model: "mock" };
  };
  const registry = fakeRegistry({ create_or_load_brief: () => ok(["asset_brief"]) });

  const parked = await runOrchestratorToCompletion("run1", deps(store, model, registry));
  assert.equal(parked.status, "waiting");
  assert.equal(store.actions.length, 0, "tool must not execute before approval");
  assert.equal(store.gates[0].status, "reached");

  // User approves the gate, then the run resumes.
  store.gates[0].status = "approved";
  const resumed = await resumeOrchestratorRun("run1", deps(store, model, registry));
  assert.equal(resumed.status, "succeeded");
  assert.equal(store.actions.length, 1);
});

test("a rejected gate records a failure and lets the model continue (never parks forever)", async () => {
  const store = new FakeStore(runFixture(), [gateFixture("create_or_load_brief", "rejected")]);
  // The model first tries the rejected tool, then (seeing it failed) finishes.
  const { model } = scriptedModel([
    { type: "tool_call", toolName: "create_or_load_brief" },
    { type: "done" },
  ]);
  const registry = fakeRegistry({ create_or_load_brief: () => ok(["asset_brief"]) });

  const run = await runOrchestratorToCompletion("run1", deps(store, model, registry));

  assert.equal(run.status, "succeeded", "must not be left waiting on a rejected gate");
  assert.equal(store.actions.length, 1);
  assert.equal(store.actions[0].status, "failed", "the rejected stage is recorded as a failure");
});

test("a tool that throws marks the run failed with a persisted error", async () => {
  const store = new FakeStore(runFixture());
  const { model } = scriptedModel([{ type: "tool_call", toolName: "plan_shots" }]);
  const registry = fakeRegistry({
    plan_shots: () => {
      throw new Error("database is down");
    },
  });

  const run = await runOrchestratorToCompletion("run1", deps(store, model, registry));

  assert.equal(run.status, "failed", "an exception must not leave the run stuck running");
  assert.match((run.error as { message?: string }).message ?? "", /database is down/);
  assert.equal(store.actions.length, 1);
  assert.equal(store.actions[0].status, "failed");
});

test("a recoverable failure keeps the run going; an unrecoverable one fails it", async () => {
  const recoverableStore = new FakeStore(runFixture());
  const { model: recModel } = scriptedModel([
    { type: "tool_call", toolName: "plan_shots" },
    { type: "done" },
  ]);
  const recoverable = await runOrchestratorToCompletion(
    "run1",
    deps(
      recoverableStore,
      recModel,
      fakeRegistry({
        plan_shots: () => ({
          status: "failed",
          error: { kind: "provider_quota", message: "rate limited", recoverable: true },
        }),
      })
    )
  );
  assert.equal(recoverable.status, "succeeded");
  assert.equal(recoverableStore.actions[0].status, "failed");

  const fatalStore = new FakeStore(runFixture());
  const { model: fatalModel } = scriptedModel([{ type: "tool_call", toolName: "plan_shots" }]);
  const fatal = await runOrchestratorToCompletion(
    "run1",
    deps(
      fatalStore,
      fatalModel,
      fakeRegistry({
        plan_shots: () => ({
          status: "failed",
          error: { kind: "policy_violation", message: "nope", recoverable: false },
        }),
      })
    )
  );
  assert.equal(fatal.status, "failed");
  assert.equal((fatal.error as { kind?: string }).kind, "policy_violation");
});

test("stops the run when the budget is exhausted", async () => {
  const store = new FakeStore(runFixture({ budgetUsd: 1 }));
  const { model } = scriptedModel([
    { type: "tool_call", toolName: "plan_shots" },
    { type: "tool_call", toolName: "plan_shots" },
  ]);
  const registry = fakeRegistry({ plan_shots: () => ok([], 2) }); // costs 2 > budget 1

  const run = await runOrchestratorToCompletion("run1", deps(store, model, registry));
  assert.equal(run.status, "failed");
  assert.equal((run.error as { kind?: string }).kind, "budget_exceeded");
  assert.equal(store.actions.length, 1, "only the first tool runs before the budget trips");
});
