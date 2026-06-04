import { createHash } from "crypto";

import { Actor } from "../actor";
import { ApiError } from "../errors";
import * as ids from "../ids";
import { Logger, createLogger } from "../logger";
import { V1Store } from "../store";
import { GenerationJob, GenerationJobInput, GenerationRequest, SCHEMA } from "@popcorn/shared/v1/types";
import { prepareGeneration } from "./prepare";

// --- Idempotency -----------------------------------------------------------

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function idempotencyScope(actor: Actor, projectId: string, key: string): string {
  return sha256(
    `${actor.workspaceId}|POST|/api/v1/projects/${projectId}/generations|${key}`
  );
}

// Canonical hash of the original request body. Idempotency compares the
// request a client sent, not the resolved inputs — resolved inputs depend on
// mutable asset/composition state that may change between retries, and a retry
// after network loss must replay the original job regardless.
function requestBodyHash(body: GenerationRequest): string {
  return sha256(
    JSON.stringify({
      briefVersionId: body.briefVersionId ?? null,
      compositionId: body.compositionId ?? null,
      assetIds: Array.isArray(body.assetIds) ? body.assetIds.map((id) => String(id)) : [],
      variantCount: body.variantCount ?? 1,
      audioAlignment: body.audioAlignment ?? null,
      showCaptions: body.showCaptions ?? null,
    })
  );
}

// --- Job creation ----------------------------------------------------------

function buildJob(
  actor: Actor,
  projectId: string,
  input: GenerationJobInput,
  options: { idempotencyKey?: string; requestId?: string }
): GenerationJob {
  const now = new Date().toISOString();
  return {
    id: ids.jobId(),
    schemaVersion: SCHEMA.job,
    workspaceId: actor.workspaceId,
    projectId,
    ...(options.requestId ? { requestId: options.requestId } : {}),
    type: "generation",
    status: "queued",
    progress: { currentStep: "validating_request", stepStartedAt: now, percent: 0 },
    input,
    result: null,
    error: null,
    ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

export async function createGenerationJob(args: {
  store: V1Store;
  actor: Actor;
  projectId: string;
  body: GenerationRequest;
  idempotencyKey?: string;
  requestId?: string;
  logger?: Logger;
}): Promise<GenerationJob> {
  const { store, actor, projectId, body, idempotencyKey, requestId } = args;
  const logger =
    args.logger ??
    createLogger({
      requestId,
      workspaceId: actor.workspaceId,
      projectId,
      jobType: "generation",
    });

  if (idempotencyKey) {
    const scope = idempotencyScope(actor, projectId, idempotencyKey);
    const requestHash = requestBodyHash(body);
    const existing = await store.getIdempotency(scope);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new ApiError(
          "idempotency_conflict",
          "Idempotency-Key was reused with a different request body."
        );
      }
      // Same key + same body: replay the original job without re-validating
      // or re-resolving, so changed asset/composition state can't turn a retry
      // into a spurious error.
      const prior = (await store.getJob(existing.jobId)) as GenerationJob | null;
      if (prior) {
        logger.info("job.replayed", { jobId: prior.id, idempotencyKey });
        return prior;
      }
      // Record exists but the job is gone — fall through and recreate it.
    }
    const input = await prepareGeneration(store, actor.workspaceId, projectId, body);
    const job = buildJob(actor, projectId, input, { idempotencyKey, requestId });
    await store.saveJob(job);
    await store.saveIdempotency(scope, {
      requestHash,
      jobId: job.id,
      createdAt: new Date().toISOString(),
    });
    logger.info("job.created", { jobId: job.id, idempotent: true });
    return job;
  }

  const input = await prepareGeneration(store, actor.workspaceId, projectId, body);
  const job = buildJob(actor, projectId, input, { requestId });
  await store.saveJob(job);
  logger.info("job.created", { jobId: job.id, idempotent: false });
  return job;
}
