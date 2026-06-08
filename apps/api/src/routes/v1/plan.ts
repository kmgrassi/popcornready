// P1 granular generation routes: the story/plan stage as a dedicated endpoint
// (docs/scopes/granular-generation-api.md §3). Thin HTTP wiring over the
// handlers in @/lib/api/v1/plan — idempotency, auth scoping, and the typed
// error envelope all come from the shared adapter (mutation/route).
//
//   POST   /projects/:projectId/plan           — plan / replan (story → beats)
//   GET    /projects/:projectId/plan/:jobId     — poll a plan job
//   POST   /projects/:projectId/plan/critique   — critique a plan
//   GET    /projects/:projectId/plan/critique/:jobId — poll a critique job

import { Router } from "express";
import { mutation, route } from "@/core/adapter";
import { ApiError } from "@/core/errors";
import {
  createPlan,
  createPlanCritique,
  getPlanJob,
} from "@/lib/api/v1/plan";

export const planRouter = Router();

function requireProjectId(projectId: string | undefined): string {
  if (!projectId) {
    throw new ApiError("validation_failed", "projectId is required.");
  }
  return projectId;
}

function requireJobId(jobId: string | undefined): string {
  if (!jobId) {
    throw new ApiError("validation_failed", "jobId is required.");
  }
  return jobId;
}

// Critique is a sub-path of /plan; declare it before the :jobId routes so
// "critique" is not captured as a job id.
planRouter.post(
  "/projects/:projectId/plan/critique",
  mutation(async ({ auth, body }, params) =>
    createPlanCritique({
      auth,
      projectId: requireProjectId(params.projectId),
      body,
    })
  )
);

planRouter.get(
  "/projects/:projectId/plan/critique/:jobId",
  route(async ({ auth }, params) =>
    getPlanJob({
      auth,
      projectId: requireProjectId(params.projectId),
      jobId: requireJobId(params.jobId),
    })
  )
);

planRouter.post(
  "/projects/:projectId/plan",
  mutation(async ({ auth, body }, params) =>
    createPlan({
      auth,
      projectId: requireProjectId(params.projectId),
      body,
    })
  )
);

planRouter.get(
  "/projects/:projectId/plan/:jobId",
  route(async ({ auth }, params) =>
    getPlanJob({
      auth,
      projectId: requireProjectId(params.projectId),
      jobId: requireJobId(params.jobId),
    })
  )
);
