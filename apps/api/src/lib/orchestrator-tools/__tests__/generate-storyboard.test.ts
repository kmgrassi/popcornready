import assert from "node:assert/strict";
import test from "node:test";

import type { AuthContext } from "@/lib/api/v1/auth";
import type { EditPlan } from "@popcorn/shared/types";
import { createGenerateStoryboardTool } from "../generate-storyboard";
import { runStoryboardJob } from "../storyboard-job";
import type { ToolCallResult } from "../types";

const auth: AuthContext = {
  mode: "local",
  actor: { id: "local_dev", type: "local" },
  workspaceId: "ws_1",
  isLocal: true,
};

const samplePlan: EditPlan = {
  targetLengthSec: 15,
  style: "playful",
  aspectRatio: "9:16",
  scenes: [
    { id: "s1", name: "Setup", beats: [{ id: "b1", name: "Hook", durationSec: 5, intent: "hook" }] },
  ],
};

const activePlan = { plan: samplePlan, assetId: "plan_1", contentHash: "ph" };

function queuedJob() {
  return {
    job: {
      id: "job_1",
      type: "asset_generation" as const,
      status: "queued" as const,
      projectId: "proj_1",
      createdAt: "t",
      updatedAt: "t",
    },
    created: true,
  };
}

// ---------- tool ----------

test("generate_storyboard requires a plan (suggests plan_shots)", async () => {
  const tool = createGenerateStoryboardTool({
    getActiveProjectPlan: async () => null,
    createJob: async () => {
      throw new Error("must not create a job without a plan");
    },
    runStoryboardJob: async () => {},
  });

  const result = (await tool.execute({}, { auth, projectId: "proj_1" })) as ToolCallResult;
  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.equal(result.error.kind, "precondition_unmet");
    assert.equal(result.error.unmetRequirements?.[0]?.satisfyWith.tool, "plan_shots");
  }
});

test("generate_storyboard accepts and kicks off the worker with run + plan", async () => {
  let kicked: { jobId: string; orchestratorRunId?: string; planAssetId: string } | undefined;
  const tool = createGenerateStoryboardTool({
    getActiveProjectPlan: async () => activePlan,
    createJob: async () => queuedJob(),
    runStoryboardJob: async (input) => {
      kicked = input;
    },
  });

  const result = (await tool.execute(
    {},
    { auth, projectId: "proj_1", orchestratorRunId: "run_1" }
  )) as ToolCallResult;

  assert.equal(result.status, "accepted");
  if (result.status === "accepted") {
    assert.equal(result.jobId, "job_1");
    assert.equal(result.resumesWhen, "job_terminal");
  }
  await new Promise((resolve) => setImmediate(resolve)); // let the fire-and-forget run
  assert.equal(kicked?.jobId, "job_1");
  assert.equal(kicked?.orchestratorRunId, "run_1");
  assert.equal(kicked?.planAssetId, "plan_1");
});

// ---------- worker ----------

function jobsSpy() {
  const calls: string[] = [];
  let succeededResult: unknown;
  return {
    calls,
    get succeededResult() {
      return succeededResult;
    },
    jobs: {
      async setStep() {
        calls.push("setStep");
        return {} as never;
      },
      async succeed(_id: string, result: unknown) {
        calls.push("succeed");
        succeededResult = result;
        return {} as never;
      },
      async fail() {
        calls.push("fail");
        return {} as never;
      },
    },
  };
}

const workerInput = {
  jobId: "job_1",
  workspaceId: "ws_1",
  projectId: "proj_1",
  orchestratorRunId: "run_1",
  plan: samplePlan,
  planAssetId: "plan_1",
  planContentHash: "ph",
};

test("runStoryboardJob persists tiles + storyboard, succeeds the job, and resumes the run", async () => {
  const spy = jobsSpy();
  let resumedRun: string | undefined;

  await runStoryboardJob(workerInput, {
    generateStoryboardTilesForPlan: async () => [{} as never],
    addStoryboardTiles: async () => [{ beatId: "b1", assetId: "tile_1" }],
    buildStoryboardForPlan: async () => ({ storyboardId: "sb_1", panelCount: 1 }),
    jobs: spy.jobs,
    resumeOrchestratorRun: async (runId) => {
      resumedRun = runId;
    },
  });

  assert.deepEqual(spy.succeededResult, { assetIds: ["tile_1"], storyboardId: "sb_1" });
  assert.equal(resumedRun, "run_1");
  assert.ok(!spy.calls.includes("fail"));
});

test("runStoryboardJob fails the job on error but still resumes the run", async () => {
  const spy = jobsSpy();
  let resumed = false;

  await runStoryboardJob(workerInput, {
    generateStoryboardTilesForPlan: async () => {
      throw new Error("provider boom");
    },
    jobs: spy.jobs,
    resumeOrchestratorRun: async () => {
      resumed = true;
    },
  });

  assert.ok(spy.calls.includes("fail"));
  assert.ok(!spy.calls.includes("succeed"));
  assert.ok(resumed, "the run must resume so it can record the failure");
});
