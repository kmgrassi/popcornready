import { Router } from "express";
import { route } from "@/core/adapter";
import { ApiError } from "@/core/errors";
import type { AssetKind } from "@popcorn/shared/v1/types";
import { parsePagination } from "@/lib/api/v1/schemas";
import { listWorkspaceAssets } from "@/lib/api/v1/store";

const ASSET_KIND_VALUES: AssetKind[] = ["video", "image", "audio"];

export const workspacesRouter = Router();

// Cross-project asset list for the dashboard. Scoped to the caller's own
// workspace; the :workspaceId path segment must match the authenticated
// workspace (the session is the source of truth, the param is a guard).
workspacesRouter.get(
  "/workspaces/:workspaceId/assets",
  route(async ({ auth, req }, params) => {
    const workspaceId = params.workspaceId;
    if (!workspaceId) {
      throw new ApiError("validation_failed", "workspaceId is required.");
    }
    if (workspaceId !== auth.workspaceId) {
      throw new ApiError(
        "forbidden",
        "You can only list assets in your own workspace."
      );
    }

    const { limit, cursor } = parsePagination(req.searchParams);
    const kindParam = req.searchParams.get("kind") ?? undefined;
    const sourceParam = req.searchParams.get("source") ?? undefined;
    const projectId = req.searchParams.get("projectId") ?? undefined;

    // "all"/absent means no filter; a present-but-unknown kind is a client error
    // (an unchecked cast would reach the asset_kind enum cast and 500).
    let kind: AssetKind | undefined;
    if (kindParam && kindParam !== "all") {
      if (!ASSET_KIND_VALUES.includes(kindParam as AssetKind)) {
        throw new ApiError(
          "validation_failed",
          `Unknown asset kind "${kindParam}". Expected one of: ${ASSET_KIND_VALUES.join(", ")}.`
        );
      }
      kind = kindParam as AssetKind;
    }
    const source =
      sourceParam === "generated" || sourceParam === "uploaded"
        ? sourceParam
        : undefined;

    const { items, nextCursor } = await listWorkspaceAssets(
      workspaceId,
      { kind, source, projectId },
      limit,
      cursor
    );
    return {
      status: 200,
      body: { assets: items, pagination: { limit, nextCursor } },
    };
  })
);
