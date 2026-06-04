import { Router } from "express";
import { mutation, route } from "@/core/adapter";
import { ApiError } from "@/core/errors";
import {
  inventoryAssets,
  registerAsset,
  updateAssetContext,
} from "@/lib/api/v1/assets";
import {
  parseAssetInventory,
  parsePagination,
  parseRegisterAsset,
  parseUpdateAssetContext,
} from "@/lib/api/v1/schemas";
import { getAsset, listAssets } from "@/lib/api/v1/store";

export const assetsRouter = Router();

function requiredParam(params: Record<string, string | undefined>, name: string): string {
  const value = params[name];
  if (!value) {
    throw new ApiError("validation_failed", `${name} is required.`);
  }
  return value;
}

assetsRouter.get(
  "/projects/:projectId/assets",
  route(async ({ auth, req }, params) => {
    const projectId = requiredParam(params, "projectId");
    const { limit, cursor } = parsePagination(req.searchParams);
    const { items, nextCursor } = await listAssets(
      auth.workspaceId,
      projectId,
      limit,
      cursor
    );
    return {
      status: 200,
      body: { assets: items, pagination: { limit, nextCursor } },
    };
  })
);

assetsRouter.post(
  "/projects/:projectId/assets",
  mutation(async ({ auth, body }, params) => {
    const projectId = requiredParam(params, "projectId");
    const input = parseRegisterAsset(body);
    const asset = await registerAsset(auth, projectId, input);
    return { status: 201, body: { asset } };
  })
);

assetsRouter.post(
  "/projects/:projectId/assets/inventory",
  mutation(async ({ auth, body }, params) => {
    const projectId = requiredParam(params, "projectId");
    const input = parseAssetInventory(body);
    const report = await inventoryAssets(auth, projectId, input);
    return { status: 200, body: { report } };
  })
);

assetsRouter.get(
  "/projects/:projectId/assets/:assetId",
  route(async ({ auth }, params) => {
    const projectId = requiredParam(params, "projectId");
    const assetId = requiredParam(params, "assetId");
    const asset = await getAsset(auth.workspaceId, projectId, assetId);
    return { status: 200, body: { asset } };
  })
);

assetsRouter.patch(
  "/projects/:projectId/assets/:assetId/context",
  mutation(async ({ auth, body }, params) => {
    const projectId = requiredParam(params, "projectId");
    const assetId = requiredParam(params, "assetId");
    const input = parseUpdateAssetContext(body);
    const asset = await updateAssetContext(auth, projectId, assetId, input);
    return { status: 200, body: { asset } };
  })
);
