import { Router } from "express";
import { route } from "@/core/adapter";
import { ApiError } from "@/core/errors";
import type { AssetKind, GenerationRunStatus } from "@popcorn/shared/v1/types";
import { parsePagination } from "@/lib/api/v1/schemas";
import {
  getWorkspaceDashboardSummary,
  listWorkspaceAssets,
  listWorkspaceGenerationRuns,
  listWorkspaceOutputs,
} from "@/lib/api/v1/store";

const ASSET_KIND_VALUES: AssetKind[] = ["video", "image", "audio"];
const GENERATION_RUN_STATUS_VALUES: GenerationRunStatus[] = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled",
];

export const workspacesRouter = Router();

// The :workspaceId path segment must match the authenticated workspace — the
// session is the source of truth, the param is a guard. Shared by every
// cross-project workspace list below.
function requireOwnWorkspace(
  workspaceId: string | undefined,
  authWorkspaceId: string,
  what: string
): string {
  if (!workspaceId) {
    throw new ApiError("validation_failed", "workspaceId is required.");
  }
  if (workspaceId !== authWorkspaceId) {
    throw new ApiError(
      "forbidden",
      `You can only list ${what} in your own workspace.`
    );
  }
  return workspaceId;
}

// One-request summary for the guided Home launchpad. Detailed lists stay on the
// sibling collection routes below.
workspacesRouter.get(
  "/workspaces/:workspaceId/dashboard",
  route(async ({ auth }, params) => {
    const workspaceId = requireOwnWorkspace(
      params.workspaceId,
      auth.workspaceId,
      "dashboard"
    );

    const summary = await getWorkspaceDashboardSummary(workspaceId);
    return {
      status: 200,
      headers: { "Cache-Control": "no-store" },
      body: { summary },
    };
  })
);

// Cross-project asset list for the dashboard. Scoped to the caller's own
// workspace.
workspacesRouter.get(
  "/workspaces/:workspaceId/assets",
  route(async ({ auth, req }, params) => {
    const workspaceId = requireOwnWorkspace(
      params.workspaceId,
      auth.workspaceId,
      "assets"
    );

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

// Cross-project generation-run list for the Projects/Runs view. Aggregates every
// run across the workspace's projects, joining each run's owning project name.
workspacesRouter.get(
  "/workspaces/:workspaceId/generation-runs",
  route(async ({ auth, req }, params) => {
    const workspaceId = requireOwnWorkspace(
      params.workspaceId,
      auth.workspaceId,
      "generation runs"
    );

    const { limit, cursor } = parsePagination(req.searchParams);
    const projectId = req.searchParams.get("projectId") ?? undefined;
    const statusParam = req.searchParams.get("status") ?? undefined;

    // "all"/absent means no filter; a present-but-unknown status is a client
    // error rather than silently matching nothing.
    let status: GenerationRunStatus | undefined;
    if (statusParam && statusParam !== "all") {
      if (!GENERATION_RUN_STATUS_VALUES.includes(statusParam as GenerationRunStatus)) {
        throw new ApiError(
          "validation_failed",
          `Unknown run status "${statusParam}". Expected one of: ${GENERATION_RUN_STATUS_VALUES.join(", ")}.`
        );
      }
      status = statusParam as GenerationRunStatus;
    }

    const { items, nextCursor } = await listWorkspaceGenerationRuns(
      workspaceId,
      { status, projectId },
      limit,
      cursor
    );
    return {
      status: 200,
      body: { runs: items, pagination: { limit, nextCursor } },
    };
  })
);

// Cross-project output/export list for the Outputs view (where Created Videos
// relocate). Aggregates every rendered export artifact across the workspace's
// projects, joining each artifact's owning project name.
workspacesRouter.get(
  "/workspaces/:workspaceId/outputs",
  route(async ({ auth, req }, params) => {
    const workspaceId = requireOwnWorkspace(
      params.workspaceId,
      auth.workspaceId,
      "outputs"
    );

    const { limit, cursor } = parsePagination(req.searchParams);
    const projectId = req.searchParams.get("projectId") ?? undefined;

    const { items, nextCursor } = await listWorkspaceOutputs(
      workspaceId,
      { projectId },
      limit,
      cursor
    );
    return {
      status: 200,
      body: { outputs: items, pagination: { limit, nextCursor } },
    };
  })
);
