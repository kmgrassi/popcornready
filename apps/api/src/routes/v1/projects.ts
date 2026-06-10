import { Router } from "express";
import { mutation, route } from "@/core/adapter";
import { ApiError } from "@/core/errors";
import {
  parseAnalyzeBatch,
  parseCreateProject,
  parsePagination,
  parseUpdateProjectPlan,
} from "@/lib/api/v1/schemas";
import {
  analyzeAssetBatch,
  getAssetAnalysisJob,
} from "@/lib/api/v1/asset-analysis";
import {
  createProject,
  getProject,
  listProjects,
  updateProjectPlan,
} from "@/lib/api/v1/store";
import { regenerateBeatTile } from "@/lib/api/v1/storyboard";

export const projectsRouter = Router();

projectsRouter.get(
  "/projects",
  route(async ({ auth, req }) => {
    const { limit, cursor } = parsePagination(req.searchParams);
    const { items, nextCursor } = await listProjects(auth.workspaceId, limit, cursor);
    return {
      status: 200,
      body: { projects: items, pagination: { limit, nextCursor } },
    };
  })
);

projectsRouter.post(
  "/projects",
  mutation(async ({ auth, body }) => {
    const input = parseCreateProject(body);
    const { project, briefVersion } = await createProject({
      workspaceId: auth.workspaceId,
      name: input.name,
      brief: input.brief,
    });
    return {
      status: 201,
      body: {
        project,
        ...(briefVersion ? { briefVersion } : {}),
      },
    };
  })
);

projectsRouter.get(
  "/projects/:projectId",
  route(async ({ auth }, params) => {
    if (!params.projectId) {
      throw new ApiError("validation_failed", "projectId is required.");
    }
    const project = await getProject(auth.workspaceId, params.projectId);
    return { status: 200, body: { project } };
  })
);

// Persist the project's edited storyboard plan (Scenes -> Beats). Scene/beat
// ids are preserved by the editor and validated as stable + unique here.
projectsRouter.put(
  "/projects/:projectId/plan",
  mutation(async ({ auth, body }, params) => {
    if (!params.projectId) {
      throw new ApiError("validation_failed", "projectId is required.");
    }
    const plan = parseUpdateProjectPlan(body);
    const project = await updateProjectPlan(auth.workspaceId, params.projectId, plan);
    return { status: 200, body: { project } };
  })
);

// Regenerate the storyboard sketch tile for ONE beat (recompute-affected only).
projectsRouter.post(
  "/projects/:projectId/storyboard/beats/:beatId/regenerate",
  mutation(async ({ auth }, params) => {
    if (!params.projectId) {
      throw new ApiError("validation_failed", "projectId is required.");
    }
    if (!params.beatId) {
      throw new ApiError("validation_failed", "beatId is required.");
    }
    return regenerateBeatTile({
      auth,
      projectId: params.projectId,
      beatId: params.beatId,
    });
  })
);

projectsRouter.post(
  "/projects/:projectId/assets/analyze-batch",
  mutation(async ({ auth, body }, params) => {
    if (!params.projectId) {
      throw new ApiError("validation_failed", "projectId is required.");
    }
    return analyzeAssetBatch({
      auth,
      projectId: params.projectId,
      input: parseAnalyzeBatch(body),
    });
  })
);

projectsRouter.get(
  "/projects/:projectId/assets/analysis-jobs/:jobId",
  route(async ({ auth }, params) => {
    if (!params.projectId) {
      throw new ApiError("validation_failed", "projectId is required.");
    }
    if (!params.jobId) {
      throw new ApiError("validation_failed", "jobId is required.");
    }
    return getAssetAnalysisJob({
      auth,
      projectId: params.projectId,
      jobId: params.jobId,
    });
  })
);
