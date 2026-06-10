import { Router } from "express";
import { mutation, route } from "@/core/adapter";
import { ApiError } from "@/core/errors";
import {
  parseCreateStudioDraft,
  parsePagination,
  parseUpdateStudioDraft,
} from "@/lib/api/v1/schemas";
import {
  createStudioDraft,
  deleteStudioDraft,
  getStudioDraft,
  listStudioDrafts,
  updateStudioDraft,
} from "@/lib/api/v1/store";

export const studioDraftsRouter = Router();

function requireOwnWorkspace(
  workspaceId: string | undefined,
  authWorkspaceId: string
): string {
  if (!workspaceId) {
    throw new ApiError("validation_failed", "workspaceId is required.");
  }
  if (workspaceId !== authWorkspaceId) {
    throw new ApiError(
      "forbidden",
      "You can only access studio drafts in your own workspace."
    );
  }
  return workspaceId;
}

function requireDraftId(draftId: string | undefined): string {
  if (!draftId) {
    throw new ApiError("validation_failed", "draftId is required.");
  }
  return draftId;
}

studioDraftsRouter.get(
  "/workspaces/:workspaceId/studio-drafts",
  route(async ({ auth, req }, params) => {
    const workspaceId = requireOwnWorkspace(params.workspaceId, auth.workspaceId);
    const { limit, cursor } = parsePagination(req.searchParams);
    const { items, nextCursor } = await listStudioDrafts(
      workspaceId,
      { id: auth.actor.id, isLocal: auth.isLocal },
      limit,
      cursor
    );
    return {
      status: 200,
      body: { drafts: items, pagination: { limit, nextCursor } },
      headers: { "Cache-Control": "no-store" },
    };
  })
);

studioDraftsRouter.post(
  "/workspaces/:workspaceId/studio-drafts",
  mutation(async ({ auth, body }, params) => {
    const workspaceId = requireOwnWorkspace(params.workspaceId, auth.workspaceId);
    const input = parseCreateStudioDraft(body);
    const draft = await createStudioDraft({
      workspaceId,
      actor: { id: auth.actor.id, isLocal: auth.isLocal },
      payload: input.payload,
    });
    return {
      status: 201,
      body: { draft },
      headers: { "Cache-Control": "no-store" },
    };
  })
);

studioDraftsRouter.get(
  "/workspaces/:workspaceId/studio-drafts/:draftId",
  route(async ({ auth }, params) => {
    const workspaceId = requireOwnWorkspace(params.workspaceId, auth.workspaceId);
    const draft = await getStudioDraft(
      workspaceId,
      { id: auth.actor.id, isLocal: auth.isLocal },
      requireDraftId(params.draftId)
    );
    return {
      status: 200,
      body: { draft },
      headers: { "Cache-Control": "no-store" },
    };
  })
);

studioDraftsRouter.put(
  "/workspaces/:workspaceId/studio-drafts/:draftId",
  mutation(async ({ auth, body }, params) => {
    const workspaceId = requireOwnWorkspace(params.workspaceId, auth.workspaceId);
    const input = parseUpdateStudioDraft(body);
    const draft = await updateStudioDraft({
      workspaceId,
      actor: { id: auth.actor.id, isLocal: auth.isLocal },
      draftId: requireDraftId(params.draftId),
      payload: input.payload,
    });
    return {
      status: 200,
      body: { draft },
      headers: { "Cache-Control": "no-store" },
    };
  })
);

studioDraftsRouter.delete(
  "/workspaces/:workspaceId/studio-drafts/:draftId",
  mutation(async ({ auth }, params) => {
    const workspaceId = requireOwnWorkspace(params.workspaceId, auth.workspaceId);
    await deleteStudioDraft(
      workspaceId,
      { id: auth.actor.id, isLocal: auth.isLocal },
      requireDraftId(params.draftId)
    );
    return {
      status: 200,
      body: { ok: true },
      headers: { "Cache-Control": "no-store" },
    };
  })
);
