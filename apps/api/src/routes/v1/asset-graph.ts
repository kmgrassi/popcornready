import { Router } from "express";
import { route } from "@/core/adapter";
import { ApiError } from "@/core/errors";
import {
  getProjectManifest,
  getStaleCandidates,
} from "@/lib/api/v1/store";

export const assetGraphRouter = Router();

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requiredParam(params: Record<string, string | undefined>, name: string): string {
  const value = params[name];
  if (!value) {
    throw new ApiError("validation_failed", `${name} is required.`);
  }
  return value;
}

function requiredUuid(params: Record<string, string | undefined>, name: string): string {
  const value = requiredParam(params, name);
  if (!UUID_PATTERN.test(value)) {
    throw new ApiError("validation_failed", `${name} must be a UUID.`);
  }
  return value;
}

assetGraphRouter.get(
  "/projects/:projectId/manifest",
  route(async ({ auth }, params) => {
    const projectId = requiredUuid(params, "projectId");
    const manifest = await getProjectManifest(auth.workspaceId, projectId);
    return { status: 200, body: { manifest } };
  })
);

assetGraphRouter.get(
  "/projects/:projectId/assets/:assetId/stale-candidates",
  route(async ({ auth }, params) => {
    const projectId = requiredUuid(params, "projectId");
    const assetId = requiredUuid(params, "assetId");
    const staleCandidates = await getStaleCandidates(
      auth.workspaceId,
      projectId,
      assetId
    );
    return { status: 200, body: { staleCandidates } };
  })
);
