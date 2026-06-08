import assert from "node:assert/strict";
import test from "node:test";

import {
  createToolRegistry,
  isOrchestratorToolLoopEnabled,
  OrchestratorRun,
  runToolLoopTurn,
  ToolExecutionContext,
} from "../index";

function runFixture(patch: Partial<OrchestratorRun> = {}): OrchestratorRun {
  return {
    id: "orch_1",
    projectId: "proj_1",
    status: "running",
    createdAt: "2026-06-08T00:00:00.000Z",
    updatedAt: "2026-06-08T00:00:00.000Z",
    ...patch,
  };
}

test("tool-loop feature flag is opt-in", () => {
  assert.equal(isOrchestratorToolLoopEnabled({}), false);
  assert.equal(
    isOrchestratorToolLoopEnabled({ POPCORN_ORCHESTRATOR_TOOL_LOOP: "true" }),
    true
  );
  assert.equal(
    isOrchestratorToolLoopEnabled({ POPCORN_ORCHESTRATOR_TOOL_LOOP: "0" }),
    false
  );
});

test("disabled flag returns without calling the model or tool", async () => {
  const result = await runToolLoopTurn({
    run: runFixture(),
    workspaceId: "ws_1",
    inputSummary: "make a trailer",
    env: {},
    model: async () => {
      throw new Error("model should not be called");
    },
  });

  assert.equal(result.status, "disabled");
  assert.equal(result.run.status, "running");
});

test("executes one model-selected tool and keeps the run active after success", async () => {
  let seenContext: ToolExecutionContext | undefined;
  const registry = createToolRegistry({
    plan_shots: {
      execute: async (_input, context) => {
        seenContext = context;
        return {
          status: "succeeded",
          resourceIds: ["composition_1"],
          output: { plannedBeats: 3 },
        };
      },
    },
  });

  const result = await runToolLoopTurn({
    run: runFixture(),
    workspaceId: "ws_1",
    actorId: "user_1",
    requestId: "req_1",
    inputSummary: "make a trailer",
    registry,
    env: { POPCORN_ORCHESTRATOR_TOOL_LOOP: "1" },
    model: async () => ({
      type: "tool_call",
      toolName: "plan_shots",
      input: { projectId: "proj_1" },
      model: "test-model",
    }),
  });

  assert.equal(result.status, "completed_turn");
  assert.equal(result.run.status, "running");
  assert.equal(result.run.waitingOn, undefined);
  assert.equal(result.turn.terminalReason, "tool_requested");
  assert.equal(result.turn.toolCalls[0].toolName, "plan_shots");
  assert.equal(result.turn.toolCalls[0].status, "succeeded");
  assert.deepEqual(result.result, {
    status: "succeeded",
    resourceIds: ["composition_1"],
    output: { plannedBeats: 3 },
  });
  assert.deepEqual(seenContext, {
    workspaceId: "ws_1",
    projectId: "proj_1",
    orchestratorRunId: "orch_1",
    actorId: "user_1",
    requestId: "req_1",
  });
});

test("accepted async tool result parks the run on the job", async () => {
  const registry = createToolRegistry({
    generate_clip: {
      execute: async () => ({
        status: "accepted",
        jobId: "job_clip_1",
        resumesWhen: "job_terminal",
        estimatedCostUsd: 0.15,
      }),
    },
  });

  const result = await runToolLoopTurn({
    run: runFixture(),
    workspaceId: "ws_1",
    inputSummary: "generate the opening clip",
    registry,
    env: { POPCORN_ORCHESTRATOR_TOOL_LOOP: "true" },
    model: async () => ({
      type: "tool_call",
      toolName: "generate_clip",
      input: { beatId: "beat_1" },
      model: "test-model",
    }),
  });

  assert.equal(result.status, "completed_turn");
  assert.equal(result.run.status, "waiting");
  assert.deepEqual(result.run.waitingOn, {
    kind: "tool_job",
    id: "job_clip_1",
  });
  assert.equal(result.turn.terminalReason, "waiting");
  assert.equal(result.turn.toolCalls[0].status, "waiting_for_job");
  assert.equal(result.turn.toolCalls[0].jobId, "job_clip_1");
});

test("model done response marks the run succeeded without a tool invocation", async () => {
  const result = await runToolLoopTurn({
    run: runFixture(),
    workspaceId: "ws_1",
    inputSummary: "everything is complete",
    env: { POPCORN_ORCHESTRATOR_TOOL_LOOP: "yes" },
    model: async () => ({
      type: "done",
      summary: "Export is complete.",
      model: "test-model",
    }),
  });

  assert.equal(result.status, "completed_turn");
  assert.equal(result.run.status, "succeeded");
  assert.equal(result.turn.terminalReason, "done");
  assert.equal(result.turn.toolCalls.length, 0);
});

test("driver refuses to start a new model turn while the run is waiting", async () => {
  await assert.rejects(
    () =>
      runToolLoopTurn({
        run: runFixture({
          status: "waiting",
          waitingOn: { kind: "tool_job", id: "job_1" },
        }),
        workspaceId: "ws_1",
        inputSummary: "resume",
        env: { POPCORN_ORCHESTRATOR_TOOL_LOOP: "1" },
        model: async () => ({
          type: "done",
          summary: "noop",
          model: "test-model",
        }),
      }),
    /Cannot start a model tool turn while run is waiting/
  );
});
