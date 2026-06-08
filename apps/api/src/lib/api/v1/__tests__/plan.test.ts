import assert from "node:assert/strict";
import test from "node:test";

import { createPlan, createPlanCritique, type PlanDeps } from "../plan";
import { ApiError } from "../errors";
import type { AuthContext } from "../auth";
import type { EditPlan, PlanCritiqueReport } from "@popcorn/shared/types";

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";
const PROJECT_ID = "proj_1";

const auth: AuthContext = {
  mode: "local",
  actor: { id: "local_dev", type: "local" },
  workspaceId: WORKSPACE_ID,
  isLocal: true,
};

const SAMPLE_PLAN: EditPlan = {
  targetLengthSec: 30,
  style: "fast-paced social ad",
  aspectRatio: "9:16",
  scenes: [
    {
      id: "scene_1",
      name: "Scene 1",
      beats: [
        { id: "b1", name: "hook", durationSec: 6, intent: "grab attention" },
        { id: "b2", name: "payoff", durationSec: 8, intent: "deliver the idea" },
      ],
    },
  ],
};

// In-memory deps: no Supabase, no Anthropic. Records what the handler asked for
// so the test can assert on persistence + agent wiring.
function makeDeps(overrides: Partial<PlanDeps> = {}): {
  deps: Partial<PlanDeps>;
  calls: {
    planEdit: number;
    critiquePlan: number;
    savedCompositions: unknown[];
    createdBriefs: unknown[];
    createdJobs: unknown[];
  };
} {
  const calls = {
    planEdit: 0,
    critiquePlan: 0,
    savedCompositions: [] as unknown[],
    createdBriefs: [] as unknown[],
    createdJobs: [] as unknown[],
  };
  const deps: Partial<PlanDeps> = {
    getProject: (async () => ({})) as unknown as PlanDeps["getProject"],
    planEdit: (async (input) => {
      calls.planEdit += 1;
      return { ...SAMPLE_PLAN, aspectRatio: input.aspectRatio };
    }) as PlanDeps["planEdit"],
    critiquePlan: (async (input) => {
      calls.critiquePlan += 1;
      const report: PlanCritiqueReport = {
        storyArc: { score: 8, notes: "ok" },
        characterContinuity: { score: 8, notes: "ok" },
        promptReadiness: { score: 8, notes: "ok" },
        visualFeasibility: { score: 8, notes: "ok" },
        summary: "looks good",
        issues: [],
        revisedPlan: input.plan,
      } as unknown as PlanCritiqueReport;
      return report;
    }) as PlanDeps["critiquePlan"],
    createBriefVersion: (async (_ws: string, projectId: string, brief: unknown) => {
      calls.createdBriefs.push(brief);
      return {
        project: {},
        briefVersion: {
          id: "brief_v1",
          schemaVersion: "brief.v1",
          projectId,
          brief,
          createdAt: new Date().toISOString(),
        },
      };
    }) as unknown as PlanDeps["createBriefVersion"],
    listBriefVersions: (async () => ({
      items: [],
      nextCursor: null,
    })) as unknown as PlanDeps["listBriefVersions"],
    saveCompositionPlan: (async (_ws: string, composition: { id: string }) => {
      calls.savedCompositions.push(composition);
      return { ...composition, id: "comp_1" };
    }) as unknown as PlanDeps["saveCompositionPlan"],
    getCompositionPlan: (async () => {
      throw new ApiError("not_found", "no composition");
    }) as unknown as PlanDeps["getCompositionPlan"],
    createJob: (async (input: {
      workspaceId: string;
      projectId: string;
      type: string;
      status?: string;
      payload?: unknown;
      result?: unknown;
    }) => {
      calls.createdJobs.push(input);
      return {
        id: "job_1",
        schemaVersion: "job.v1",
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        type: input.type,
        status: input.status ?? "queued",
        progress: {},
        input: input.payload ?? null,
        result: input.result ?? null,
        error: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }) as unknown as PlanDeps["createJob"],
    getJob: (async () => {
      throw new ApiError("not_found", "no job");
    }) as unknown as PlanDeps["getJob"],
    ...overrides,
  };
  return { deps, calls };
}

test("plan from a prompt: creates a brief, runs planEdit, persists a composition, returns a succeeded job", async () => {
  const { deps, calls } = makeDeps();
  const res = await createPlan({
    auth,
    projectId: PROJECT_ID,
    body: { prompt: "a dog learns to surf", targetLengthSec: 20, aspectRatio: "16:9" },
    deps,
  });

  assert.equal(res.status, 202);
  const job = res.body.job as { status: string; type: string; result: { plan: EditPlan; compositionId?: string } };
  assert.equal(job.status, "succeeded");
  assert.equal(job.type, "composition");
  assert.equal(job.result.compositionId, "comp_1");
  assert.equal(job.result.plan.aspectRatio, "16:9");

  assert.equal(calls.planEdit, 1);
  assert.equal(calls.createdBriefs.length, 1);
  assert.equal(calls.savedCompositions.length, 1);
  // The composition mirrors the plan's beats.
  const comp = calls.savedCompositions[0] as { plannedBeats: unknown[]; status: string };
  assert.equal(comp.plannedBeats.length, 2);
  assert.equal(comp.status, "planning");
});

test("plan with persist:false skips composition persistence", async () => {
  const { deps, calls } = makeDeps();
  const res = await createPlan({
    auth,
    projectId: PROJECT_ID,
    body: { prompt: "a quiet morning", persist: false },
    deps,
  });

  const job = res.body.job as { result: { compositionId?: string } };
  assert.equal(job.result.compositionId, undefined);
  assert.equal(calls.savedCompositions.length, 0);
  assert.equal(calls.planEdit, 1);
});

test("plan precondition: missing prompt and briefVersionId throws a typed validation error", async () => {
  const { deps, calls } = makeDeps();
  await assert.rejects(
    createPlan({ auth, projectId: PROJECT_ID, body: {}, deps }),
    (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.code, "validation_failed");
      // The error names what's needed so an agent can self-heal.
      assert.match(err.message, /prompt or briefVersionId/i);
      return true;
    }
  );
  // No planning work was done.
  assert.equal(calls.planEdit, 0);
  assert.equal(calls.createdBriefs.length, 0);
});

test("plan rejects both prompt and briefVersionId", async () => {
  const { deps } = makeDeps();
  await assert.rejects(
    createPlan({
      auth,
      projectId: PROJECT_ID,
      body: { prompt: "x", briefVersionId: "brief_v1" },
      deps,
    }),
    (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.code, "validation_failed");
      return true;
    }
  );
});

test("plan critique: runs critiquePlan on an inline plan and returns a succeeded job", async () => {
  const { deps, calls } = makeDeps();
  const res = await createPlanCritique({
    auth,
    projectId: PROJECT_ID,
    body: { plan: SAMPLE_PLAN, goal: "teach surfing", style: "playful", aspectRatio: "9:16" },
    deps,
  });

  assert.equal(res.status, 202);
  const job = res.body.job as { status: string; result: { report: PlanCritiqueReport } };
  assert.equal(job.status, "succeeded");
  assert.equal(job.result.report.summary, "looks good");
  assert.equal(calls.critiquePlan, 1);
});

test("plan critique precondition: missing compositionId and plan throws a typed validation error", async () => {
  const { deps, calls } = makeDeps();
  await assert.rejects(
    createPlanCritique({ auth, projectId: PROJECT_ID, body: {}, deps }),
    (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.code, "validation_failed");
      assert.match(err.message, /compositionId or plan/i);
      return true;
    }
  );
  assert.equal(calls.critiquePlan, 0);
});
