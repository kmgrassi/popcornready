import { Router } from "express";
import { mutation, route } from "@/core/adapter";
import { ApiError } from "@/core/errors";
import {
  createGeneratedAsset,
  getGeneratedAssetJob,
} from "@/lib/api/v1/generated-assets";
import { resolveActorFromRequest } from "@/lib/v1/actor";
import { createGenerationJob, runGenerationJob } from "@/lib/v1/generation";
import { createLogger } from "@/lib/v1/logger";
import { redactMessage } from "@/lib/v1/redact";
import { getStore } from "@/lib/v1/store";
import type { GenerationRequest } from "@popcorn/shared/v1/types";

export const generationsRouter = Router();

function requiredParam(params: Record<string, string | undefined>, name: string): string {
  const value = params[name];
  if (!value) {
    throw new ApiError("validation_failed", `${name} is required.`);
  }
  return value;
}

generationsRouter.post(
  "/projects/:projectId/generations",
  mutation(async ({ body, req, requestId }, params) => {
    const projectId = requiredParam(params, "projectId");
    const actor = await resolveActorFromRequest(req);
    const logger = createLogger({
      requestId,
      workspaceId: actor.workspaceId,
      projectId,
      jobType: "generation",
    });
    const store = getStore();
    const idempotencyKey = req.header("Idempotency-Key") || undefined;
    const requestBody = (body ?? {}) as GenerationRequest;

    logger.info("http.request.started", {
      method: "POST",
      route: "/api/v1/projects/:projectId/generations",
    });

    const startedAt = Date.now();
    const job = await createGenerationJob({
      store,
      actor,
      projectId,
      body: requestBody,
      idempotencyKey,
      requestId,
      logger,
    });

    if (job.status === "queued") {
      void runGenerationJob(store, job.id).catch((err) => {
        logger.error("job.run.crashed", {
          jobId: job.id,
          error: {
            message: redactMessage(err instanceof Error ? err.message : String(err)),
          },
        });
      });
    }

    logger.info("http.request.finished", {
      jobId: job.id,
      status: 202,
      durationMs: Date.now() - startedAt,
    });

    return { status: 202, body: { job } };
  })
);

generationsRouter.get(
  "/projects/:projectId/generations/:jobId",
  route(async (_ctx, params) => {
    const projectId = requiredParam(params, "projectId");
    const jobId = requiredParam(params, "jobId");
    const store = getStore();
    const job = await store.getJob(jobId);

    if (!job || job.projectId !== projectId || job.type !== "generation") {
      throw new ApiError("not_found", `Generation job not found: ${jobId}`);
    }

    return { status: 200, body: { job } };
  })
);

generationsRouter.post(
  "/projects/:projectId/generated-assets",
  mutation(async ({ auth, body }, params) =>
    createGeneratedAsset({
      auth,
      projectId: requiredParam(params, "projectId"),
      body,
    })
  )
);

generationsRouter.get(
  "/projects/:projectId/generated-assets/:jobId",
  route(async ({ auth }, params) =>
    getGeneratedAssetJob({
      auth,
      projectId: requiredParam(params, "projectId"),
      jobId: requiredParam(params, "jobId"),
    })
  )
);
