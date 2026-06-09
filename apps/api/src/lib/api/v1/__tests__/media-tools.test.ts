import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { AuthContext } from "../auth";
import type { ApiResult } from "../generated-assets";
import type { V1Job } from "../jobs";
import {
  resumeGenerateClipTool,
  startGenerateClipTool,
} from "../media-tools";
import { setBeatMediaDepsForTests } from "../beats";

const LOCAL_WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";

const auth: AuthContext = {
  mode: "local",
  actor: { id: "local_dev", type: "local" },
  workspaceId: LOCAL_WORKSPACE_ID,
  isLocal: true,
};

function job(overrides: Partial<V1Job> = {}): V1Job {
  return {
    id: "job_clip_1",
    schemaVersion: "job.v1",
    workspaceId: LOCAL_WORKSPACE_ID,
    projectId: "proj_1",
    type: "asset_generation",
    status: "running",
    result: null,
    error: null,
    createdAt: "2026-06-08T00:00:00.000Z",
    updatedAt: "2026-06-08T00:00:00.000Z",
    ...overrides,
  };
}

function apiJob(result: V1Job): ApiResult {
  return { status: 202, body: { job: result } };
}

afterEach(() => setBeatMediaDepsForTests(null));

test("startGenerateClipTool starts the beat clip job and returns accepted(jobId)", async () => {
  const enqueuedBodies: unknown[] = [];
  let generatorCalled = false;
  setBeatMediaDepsForTests({
    enqueueGeneratedAssetJob: async ({ body }) => {
      enqueuedBodies.push(body);
      return job({ status: "queued", input: { body } });
    },
    createGeneratedAsset: async () => {
      generatorCalled = true;
      return apiJob(job());
    },
  });

  const result = await startGenerateClipTool({
    auth,
    projectId: "proj_1",
    input: {
      beatId: "beat_1",
      prompt: "A slow push-in on the discovery.",
      provider: "mock",
      anchorIds: ["anchor_lab"],
    },
  });

  assert.deepEqual(result, {
    status: "accepted",
    jobId: "job_clip_1",
    resumesWhen: "job_terminal",
  });
  assert.equal((enqueuedBodies[0] as Record<string, unknown>).kind, "video");
  assert.equal((enqueuedBodies[0] as Record<string, unknown>).beatId, "beat_1");
  assert.deepEqual((enqueuedBodies[0] as Record<string, unknown>).anchorIds, [
    "anchor_lab",
  ]);
  assert.equal(generatorCalled, false);
});

test("resumeGenerateClipTool returns accepted while the job is not terminal", async () => {
  setBeatMediaDepsForTests({
    getGeneratedAssetJob: async () => apiJob(job({ status: "running" })),
  });

  const result = await resumeGenerateClipTool({
    auth,
    projectId: "proj_1",
    jobId: "job_clip_1",
  });

  assert.deepEqual(result, {
    status: "accepted",
    jobId: "job_clip_1",
    resumesWhen: "job_terminal",
  });
});

test("resumeGenerateClipTool returns generated asset ids after job success", async () => {
  setBeatMediaDepsForTests({
    getGeneratedAssetJob: async () =>
      apiJob(
        job({
          status: "succeeded",
          result: { assetIds: ["asset_clip_1"] },
        })
      ),
  });

  const result = await resumeGenerateClipTool({
    auth,
    projectId: "proj_1",
    jobId: "job_clip_1",
  });

  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.resourceIds, ["asset_clip_1"]);
  assert.deepEqual(result.artifactIds, ["asset_clip_1"]);
});

test("resumeGenerateClipTool maps provider quota failures to ToolError", async () => {
  setBeatMediaDepsForTests({
    getGeneratedAssetJob: async () =>
      apiJob(
        job({
          status: "failed",
          error: { code: "rate_limited", message: "Provider quota exhausted." },
        })
      ),
  });

  const result = await resumeGenerateClipTool({
    auth,
    projectId: "proj_1",
    jobId: "job_clip_1",
  });

  assert.equal(result.status, "failed");
  assert.equal(result.error.kind, "provider_quota");
  assert.equal(result.error.recoverable, true);
  assert.equal(result.error.retryAfterSec, 60);
});

test("resumeGenerateClipTool maps provider failures to ToolError", async () => {
  setBeatMediaDepsForTests({
    getGeneratedAssetJob: async () =>
      apiJob(
        job({
          status: "failed",
          error: { code: "job_failed", message: "Provider returned an invalid video." },
        })
      ),
  });

  const result = await resumeGenerateClipTool({
    auth,
    projectId: "proj_1",
    jobId: "job_clip_1",
  });

  assert.equal(result.status, "failed");
  assert.equal(result.error.kind, "provider_failed");
  assert.equal(result.error.recoverable, true);
});

test("startGenerateClipTool validates the required beat id before spending", async () => {
  let enqueueCalled = false;
  setBeatMediaDepsForTests({
    enqueueGeneratedAssetJob: async () => {
      enqueueCalled = true;
      return job();
    },
  });

  const result = await startGenerateClipTool({
    auth,
    projectId: "proj_1",
    input: { prompt: "No beat id.", provider: "mock" },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.error.kind, "invalid_input");
  assert.equal(enqueueCalled, false);
});
