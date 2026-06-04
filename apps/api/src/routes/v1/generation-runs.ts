import { Router } from "express";
import { mutation, route } from "@/core/adapter";
import { ApiError } from "@/core/errors";
import { getProject } from "@/lib/api/v1/store";
import {
  approveReviewGate,
  assemblePayload,
  cancelGenerationRun,
  createRunWithSeedStages,
  getGenerationRunStore,
  rejectReviewGate,
  requireRun,
  type CreateGenerationRunBody,
} from "@/lib/v1/generation-runs";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

function requireParam(params: Record<string, string | undefined>, name: string): string {
  const value = params[name];
  if (!value) {
    throw new ApiError("validation_failed", `${name} is required.`);
  }
  return value;
}

async function requireProjectAccess(workspaceId: string, projectId: string): Promise<void> {
  await getProject(workspaceId, projectId);
}

export const generationRunsRouter = Router();

generationRunsRouter.get(
  "/projects/:projectId/generation-runs",
  route(async ({ auth }, params) => {
    const projectId = requireParam(params, "projectId");
    await requireProjectAccess(auth.workspaceId, projectId);

    const store = getGenerationRunStore();
    const runs = (await store.listRunsForProject(projectId)).sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : -1
    );

    return {
      status: 200,
      body: { runs },
      headers: NO_STORE_HEADERS,
    };
  })
);

generationRunsRouter.post(
  "/projects/:projectId/generation-runs",
  mutation(async ({ auth, body }, params) => {
    const projectId = requireParam(params, "projectId");
    await requireProjectAccess(auth.workspaceId, projectId);

    const store = getGenerationRunStore();
    const payload = await createRunWithSeedStages({
      store,
      projectId,
      body: (body ?? {}) as CreateGenerationRunBody,
    });

    return { status: 202, body: payload };
  })
);

generationRunsRouter.get(
  "/projects/:projectId/generation-runs/:runId",
  route(async ({ auth }, params) => {
    const projectId = requireParam(params, "projectId");
    const runId = requireParam(params, "runId");
    await requireProjectAccess(auth.workspaceId, projectId);

    const store = getGenerationRunStore();
    const payload = await assemblePayload(store, runId);
    const verified = requireRun(payload, runId, projectId);

    return {
      status: 200,
      body: verified,
      headers: NO_STORE_HEADERS,
    };
  })
);

generationRunsRouter.post(
  "/projects/:projectId/generation-runs/:runId/approve",
  mutation(async ({ auth }, params) => {
    const projectId = requireParam(params, "projectId");
    const runId = requireParam(params, "runId");
    await requireProjectAccess(auth.workspaceId, projectId);

    const store = getGenerationRunStore();
    const payload = await assemblePayload(store, runId);
    requireRun(payload, runId, projectId);

    const approved = await approveReviewGate(store, runId);
    return { status: 200, body: approved };
  })
);

generationRunsRouter.post(
  "/projects/:projectId/generation-runs/:runId/reject",
  mutation(async ({ auth, body }, params) => {
    const projectId = requireParam(params, "projectId");
    const runId = requireParam(params, "runId");
    await requireProjectAccess(auth.workspaceId, projectId);

    const store = getGenerationRunStore();
    const payload = await assemblePayload(store, runId);
    requireRun(payload, runId, projectId);

    const rejected = await rejectReviewGate(store, runId, body ?? {});
    return { status: 200, body: rejected };
  })
);

generationRunsRouter.post(
  "/projects/:projectId/generation-runs/:runId/cancel",
  mutation(async ({ auth }, params) => {
    const projectId = requireParam(params, "projectId");
    const runId = requireParam(params, "runId");
    await requireProjectAccess(auth.workspaceId, projectId);

    const store = getGenerationRunStore();
    const payload = await assemblePayload(store, runId);
    requireRun(payload, runId, projectId);

    const canceled = await cancelGenerationRun(store, runId);
    return { status: 200, body: canceled };
  })
);

generationRunsRouter.post(
  "/projects/:projectId/generation-runs/:runId/retry",
  mutation(async ({ auth }, params) => {
    const projectId = requireParam(params, "projectId");
    const runId = requireParam(params, "runId");
    await requireProjectAccess(auth.workspaceId, projectId);

    const store = getGenerationRunStore();
    const payload = await assemblePayload(store, runId);
    requireRun(payload, runId, projectId);

    throw new ApiError(
      "not_implemented",
      "Retry is not supported for generation runs yet.",
      { supported: false, action: "retry" }
    );
  })
);
