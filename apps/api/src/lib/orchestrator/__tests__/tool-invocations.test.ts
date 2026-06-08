import assert from "node:assert/strict";
import { mkdtemp, rm } from "fs/promises";
import os from "os";
import path from "path";
import test from "node:test";

import { withLocalDir } from "../../api/v1/store";
import {
  completeToolInvocation,
  createOrchestratorRun,
  createOrchestratorTurn,
  createToolInvocation,
  findToolInvocationWaitingOn,
  getOrchestratorRun,
  getOrchestratorTurn,
  getToolInvocation,
  listRunsReadyToResume,
  listToolInvocationsForRun,
  listWaitingToolInvocations,
  markToolInvocationWaitingForApproval,
  markToolInvocationWaitingForJob,
} from "../tool-invocations";

async function withTempLocalDir<T>(fn: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "popcorn-orchestrator-"));
  try {
    return await withLocalDir(dir, fn);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("persists run, turn, and requested invocation", async () => {
  await withTempLocalDir(async () => {
    const run = await createOrchestratorRun({
      projectId: "proj_1",
      generationRunId: "gen_1",
      budget: { maxUsd: 2, spentUsd: 0, proposedUsd: 0 },
    });
    const turn = await createOrchestratorTurn({
      orchestratorRunId: run.id,
      inputSummary: "Start with shot planning.",
      model: "claude-sonnet-4-5",
      terminalReason: "tool_requested",
    });
    const invocation = await createToolInvocation({
      orchestratorRunId: run.id,
      turnId: turn.id,
      toolName: "plan_shots",
      input: { projectId: "proj_1" },
    });

    const savedRun = await getOrchestratorRun(run.id);
    const savedTurn = await getOrchestratorTurn(turn.id);
    const savedInvocation = await getToolInvocation(invocation.id);

    assert.equal(savedRun?.currentTurnId, turn.id);
    assert.equal(savedRun?.status, "running");
    assert.deepEqual(savedRun?.budget, { maxUsd: 2, spentUsd: 0, proposedUsd: 0 });
    assert.deepEqual(savedTurn?.toolInvocationIds, [invocation.id]);
    assert.equal(savedInvocation?.status, "requested");
    assert.equal(savedInvocation?.toolName, "plan_shots");
  });
});

test("records async job wait and resumes from durable state after completion", async () => {
  await withTempLocalDir(async () => {
    const run = await createOrchestratorRun({ projectId: "proj_1" });
    const turn = await createOrchestratorTurn({
      orchestratorRunId: run.id,
      inputSummary: "Generate a clip.",
      model: "claude-sonnet-4-5",
      terminalReason: "tool_requested",
    });
    const invocation = await createToolInvocation({
      orchestratorRunId: run.id,
      turnId: turn.id,
      toolName: "generate_clip",
      input: { beatId: "beat_1" },
      status: "running",
    });

    await markToolInvocationWaitingForJob(invocation.id, {
      status: "accepted",
      jobId: "job_1",
      resumesWhen: "job_terminal",
      estimatedCostUsd: 0.34,
    });

    assert.equal((await getOrchestratorRun(run.id))?.status, "waiting");
    assert.deepEqual((await getOrchestratorRun(run.id))?.waitingOn, {
      kind: "tool_job",
      id: "job_1",
    });
    assert.equal((await getOrchestratorTurn(turn.id))?.terminalReason, "waiting");
    assert.equal(
      (await findToolInvocationWaitingOn({ kind: "tool_job", id: "job_1" }))?.id,
      invocation.id
    );
    assert.equal((await listWaitingToolInvocations()).length, 1);

    await completeToolInvocation(invocation.id, {
      status: "succeeded",
      result: {
        status: "succeeded",
        resourceIds: ["asset_clip_1"],
        artifactIds: ["artifact_clip_1"],
        costUsd: 0.31,
      },
    });

    const resumedRun = await getOrchestratorRun(run.id);
    const completedInvocation = await getToolInvocation(invocation.id);

    assert.equal(resumedRun?.status, "running");
    assert.equal(resumedRun?.waitingOn, undefined);
    assert.equal((await getOrchestratorTurn(turn.id))?.terminalReason, "done");
    assert.equal(completedInvocation?.status, "succeeded");
    assert.deepEqual(completedInvocation?.result, {
      status: "succeeded",
      resourceIds: ["asset_clip_1"],
      artifactIds: ["artifact_clip_1"],
      costUsd: 0.31,
    });
    assert.deepEqual(
      (await listRunsReadyToResume()).map((candidate) => candidate.id),
      [run.id]
    );
  });
});

test("records approval waits and recoverable rejection errors", async () => {
  await withTempLocalDir(async () => {
    const run = await createOrchestratorRun({ projectId: "proj_1" });
    const turn = await createOrchestratorTurn({
      orchestratorRunId: run.id,
      inputSummary: "Ask for storyboard approval.",
      model: "claude-sonnet-4-5",
      terminalReason: "tool_requested",
    });
    const invocation = await createToolInvocation({
      orchestratorRunId: run.id,
      turnId: turn.id,
      toolName: "request_approval",
      input: { gate: "storyboard" },
    });

    await markToolInvocationWaitingForApproval(invocation.id, {
      status: "waiting_for_approval",
      gateId: "gate_1",
      resumesWhen: "approval_terminal",
      previewArtifactIds: ["storyboard_1"],
    });
    assert.equal(
      (await findToolInvocationWaitingOn({
        kind: "approval_gate",
        id: "gate_1",
      }))?.id,
      invocation.id
    );

    await completeToolInvocation(invocation.id, {
      status: "failed",
      result: {
        status: "failed",
        error: {
          kind: "approval_rejected",
          message: "Make the scene clearer.",
          recoverable: true,
          suggestedNextTools: [
            {
              tool: "plan_shots",
              inputHint: {
                revisionInstruction: "Make the scene clearer.",
              },
            },
          ],
        },
      },
    });

    const failedInvocation = await getToolInvocation(invocation.id);
    assert.equal((await getOrchestratorRun(run.id))?.waitingOn, undefined);
    assert.equal((await getOrchestratorRun(run.id))?.status, "running");
    assert.equal(failedInvocation?.status, "failed");
    assert.equal(failedInvocation?.error?.kind, "approval_rejected");
    assert.equal(failedInvocation?.error?.recoverable, true);
  });
});

test("lists invocations for a run without crossing run boundaries", async () => {
  await withTempLocalDir(async () => {
    const firstRun = await createOrchestratorRun({ projectId: "proj_1" });
    const secondRun = await createOrchestratorRun({ projectId: "proj_2" });
    const firstTurn = await createOrchestratorTurn({
      orchestratorRunId: firstRun.id,
      inputSummary: "First run",
      model: "claude-sonnet-4-5",
      terminalReason: "tool_requested",
    });
    const secondTurn = await createOrchestratorTurn({
      orchestratorRunId: secondRun.id,
      inputSummary: "Second run",
      model: "claude-sonnet-4-5",
      terminalReason: "tool_requested",
    });
    const firstInvocation = await createToolInvocation({
      orchestratorRunId: firstRun.id,
      turnId: firstTurn.id,
      toolName: "draft_script",
      input: {},
    });
    await createToolInvocation({
      orchestratorRunId: secondRun.id,
      turnId: secondTurn.id,
      toolName: "draft_script",
      input: {},
    });

    assert.deepEqual(
      (await listToolInvocationsForRun(firstRun.id)).map(
        (invocation) => invocation.id
      ),
      [firstInvocation.id]
    );
  });
});

test("rejects completing an already terminal invocation twice", async () => {
  await withTempLocalDir(async () => {
    const run = await createOrchestratorRun({ projectId: "proj_1" });
    const turn = await createOrchestratorTurn({
      orchestratorRunId: run.id,
      inputSummary: "Plan shots.",
      model: "claude-sonnet-4-5",
      terminalReason: "tool_requested",
    });
    const invocation = await createToolInvocation({
      orchestratorRunId: run.id,
      turnId: turn.id,
      toolName: "plan_shots",
      input: {},
    });
    await completeToolInvocation(invocation.id, {
      status: "succeeded",
      result: { status: "succeeded", resourceIds: ["plan_1"] },
    });

    await assert.rejects(
      () =>
        completeToolInvocation(invocation.id, {
          status: "succeeded",
          result: { status: "succeeded", resourceIds: ["plan_2"] },
        }),
      /already terminal/
    );
  });
});
