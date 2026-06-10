import { Router } from "express";
import { mutation, route } from "@/core/adapter";
import { ApiError } from "@/core/errors";
import {
  parseAnalyzeBatch,
  parseCreateProject,
  parsePagination,
} from "@/lib/api/v1/schemas";
import {
  analyzeAssetBatch,
  getAssetAnalysisJob,
} from "@/lib/api/v1/asset-analysis";
import {
  createProject,
  getProject,
  listProjects,
} from "@/lib/api/v1/store";
import { getStoryboard, putStoryboard } from "@/lib/api/v1/storyboard";

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

projectsRouter.get(
  "/projects/:projectId/storyboard",
  route(async ({ auth }, params) => {
    if (!params.projectId) {
      throw new ApiError("validation_failed", "projectId is required.");
    }
    return getStoryboard({ auth, projectId: params.projectId });
  })
);

projectsRouter.put(
  "/projects/:projectId/storyboard",
  mutation(async ({ auth, body }, params) => {
    if (!params.projectId) {
      throw new ApiError("validation_failed", "projectId is required.");
    }
    return putStoryboard({ auth, projectId: params.projectId, body });
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
