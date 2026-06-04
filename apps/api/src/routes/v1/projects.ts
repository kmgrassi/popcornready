import { Router } from "express";
import { mutation, route } from "@/core/adapter";
import { ApiError } from "@/core/errors";
import { parseCreateProject, parsePagination } from "@/lib/api/v1/schemas";
import { createProject, getProject, listProjects } from "@/lib/api/v1/store";

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
    const { project } = await createProject({
      workspaceId: auth.workspaceId,
      name: input.name,
      brief: input.brief,
    });
    return { status: 201, body: { project } };
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
