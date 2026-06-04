import { Router } from "express";
import { mutation, route } from "@/core/adapter";
import { ApiError } from "@/core/errors";
import { parseBrief, parsePagination } from "@/lib/api/v1/schemas";
import {
  createBriefVersion,
  getProject,
  listBriefVersions,
  setBrief,
} from "@/lib/api/v1/store";

export const briefRouter = Router();

function requireProjectId(projectId: string | undefined): string {
  if (!projectId) {
    throw new ApiError("validation_failed", "projectId is required.");
  }
  return projectId;
}

briefRouter.get(
  "/projects/:projectId/brief",
  route(async ({ auth }, params) => {
    const project = await getProject(auth.workspaceId, requireProjectId(params.projectId));
    if (!project.brief) {
      throw new ApiError("brief_missing", "This project has no brief yet.");
    }
    return {
      status: 200,
      body: {
        brief: project.brief,
        currentBriefVersionId: project.currentBriefVersionId,
      },
    };
  })
);

briefRouter.put(
  "/projects/:projectId/brief",
  mutation(async ({ auth, body }, params) => {
    const brief = parseBrief(body, "");
    const project = await setBrief(
      auth.workspaceId,
      requireProjectId(params.projectId),
      brief
    );
    return { status: 200, body: { project } };
  })
);

briefRouter.get(
  "/projects/:projectId/brief-versions",
  route(async ({ auth, req }, params) => {
    const { limit, cursor } = parsePagination(req.searchParams);
    const { items, nextCursor } = await listBriefVersions(
      auth.workspaceId,
      requireProjectId(params.projectId),
      limit,
      cursor
    );
    return {
      status: 200,
      body: { briefVersions: items, pagination: { limit, nextCursor } },
    };
  })
);

briefRouter.post(
  "/projects/:projectId/brief-versions",
  mutation(async ({ auth, body }, params) => {
    const brief = parseBrief(body, "");
    const { briefVersion } = await createBriefVersion(
      auth.workspaceId,
      requireProjectId(params.projectId),
      brief
    );
    return { status: 201, body: { briefVersion } };
  })
);
