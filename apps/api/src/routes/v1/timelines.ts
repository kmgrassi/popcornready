import { Router } from "express";
import { mutation, route } from "@/core/adapter";
import { errorResponse, getIdempotencyKey, loadProject } from "@/lib/agent-api/http";
import { agentApiStore } from "@/lib/agent-api/jobs";
import { ApiError as AgentApiError, toErrorEnvelope } from "@/lib/agent-api/runtime";
import type { Artifact, Job, JobType } from "@/lib/agent-api/types";
import { type ExportOptions, runExportJob, runRevisionJob } from "@/lib/agent-api/workers";
import type { ApiResult, HandlerCtx } from "@/lib/api/v1/handler";

export const timelinesRouter = Router();

type RouteParams = Record<string, string | undefined>;

function param(params: RouteParams, name: string): string {
  const value = params[name];
  if (!value) {
    throw new AgentApiError("invalid_request", 400, `A ${name} path parameter is required.`);
  }
  return value;
}

function agentErrorResult(err: unknown, requestId: string): ApiResult {
  return errorResponse(err, requestId);
}

function scopedIdempotencyKey(req: HandlerCtx["req"], projectId: string): string | null {
  const key = getIdempotencyKey(req);
  return key ? `${projectId}:${key}` : null;
}

function requireJobInProject(
  job: Job | null,
  input: { type: JobType; projectId: string; jobId: string; label: string }
): Job {
  if (!job || job.type !== input.type || job.projectId !== input.projectId) {
    throw new AgentApiError("job_not_found", 404, `${input.label} job not found.`, {
      jobId: input.jobId,
    });
  }
  return job;
}

function requireArtifactInProject(
  artifact: Artifact | null,
  projectId: string,
  artifactId: string
): Artifact {
  if (!artifact || artifact.projectId !== projectId) {
    throw new AgentApiError("artifact_not_found", 404, "Artifact not found.", {
      artifactId,
    });
  }
  return artifact;
}

function bodyRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function parseRevisionMessage(body: unknown): string {
  const message = String(bodyRecord(body).message ?? "").trim();
  if (!message) {
    throw new AgentApiError("invalid_request", 400, "A revision `message` is required.");
  }
  return message;
}

function parseExportOptions(body: unknown): ExportOptions {
  const input = bodyRecord(body);
  return {
    format: typeof input.format === "string" ? input.format : undefined,
    quality: typeof input.quality === "string" ? input.quality : undefined,
    audioAssetIds: Array.isArray(input.audioAssetIds)
      ? input.audioAssetIds.filter((id): id is string => typeof id === "string")
      : undefined,
    durationPolicy:
      typeof input.durationPolicy === "string"
        ? (input.durationPolicy as ExportOptions["durationPolicy"])
        : undefined,
    maxDeltaSec: typeof input.maxDeltaSec === "number" ? input.maxDeltaSec : undefined,
  };
}

async function createRevision(
  { body, req, requestId }: HandlerCtx,
  params: RouteParams
): Promise<ApiResult> {
  try {
    const projectId = param(params, "projectId");
    const timelineId = param(params, "timelineId");
    const message = parseRevisionMessage(body);

    const { job, created } = await agentApiStore.createOrGetJob({
      type: "revision",
      projectId,
      idempotencyKey: scopedIdempotencyKey(req, projectId),
    });
    if (!created) {
      return { status: 200, body: { job } };
    }

    try {
      await agentApiStore.setStep(job.id, "planning_timeline");
      const project = await loadProject(projectId);
      const result = await runRevisionJob({ project, timelineId, message });
      const finished = await agentApiStore.succeed(job.id, result);
      return { status: 201, body: { job: finished } };
    } catch (workerErr) {
      const { body: errBody } = toErrorEnvelope(workerErr, requestId);
      await agentApiStore.fail(job.id, errBody.error);
      return agentErrorResult(workerErr, requestId);
    }
  } catch (err) {
    return agentErrorResult(err, requestId);
  }
}

async function getRevision(
  { requestId }: HandlerCtx,
  params: RouteParams
): Promise<ApiResult> {
  try {
    const projectId = param(params, "projectId");
    const jobId = param(params, "jobId");
    const job = requireJobInProject(await agentApiStore.getJob(jobId), {
      type: "revision",
      projectId,
      jobId,
      label: "Revision",
    });
    return { status: 200, body: { job } };
  } catch (err) {
    return agentErrorResult(err, requestId);
  }
}

async function createExport(
  { body, req, requestId }: HandlerCtx,
  params: RouteParams
): Promise<ApiResult> {
  try {
    const projectId = param(params, "projectId");
    const timelineId = param(params, "timelineId");
    const options = parseExportOptions(body);

    const { job, created } = await agentApiStore.createOrGetJob({
      type: "export",
      projectId,
      idempotencyKey: scopedIdempotencyKey(req, projectId),
    });
    if (!created) {
      return { status: 200, body: { job } };
    }

    try {
      await agentApiStore.setStep(job.id, "rendering_export");
      const project = await loadProject(projectId);
      const { artifact } = runExportJob({ project, timelineId, options });
      await agentApiStore.saveArtifact(artifact);
      const finished = await agentApiStore.succeed(job.id, {
        artifactId: artifact.id,
      });
      return { status: 201, body: { job: finished } };
    } catch (workerErr) {
      const { body: errBody } = toErrorEnvelope(workerErr, requestId);
      await agentApiStore.fail(job.id, errBody.error);
      return agentErrorResult(workerErr, requestId);
    }
  } catch (err) {
    return agentErrorResult(err, requestId);
  }
}

async function getExport({ requestId }: HandlerCtx, params: RouteParams): Promise<ApiResult> {
  try {
    const projectId = param(params, "projectId");
    const jobId = param(params, "jobId");
    const job = requireJobInProject(await agentApiStore.getJob(jobId), {
      type: "export",
      projectId,
      jobId,
      label: "Export",
    });
    return { status: 200, body: { job } };
  } catch (err) {
    return agentErrorResult(err, requestId);
  }
}

async function getArtifact(
  { requestId }: HandlerCtx,
  params: RouteParams
): Promise<ApiResult> {
  try {
    const projectId = param(params, "projectId");
    const artifactId = param(params, "artifactId");
    const artifact = requireArtifactInProject(
      await agentApiStore.getArtifact(artifactId),
      projectId,
      artifactId
    );
    return { status: 200, body: { artifact } };
  } catch (err) {
    return agentErrorResult(err, requestId);
  }
}

timelinesRouter.post(
  "/projects/:projectId/timelines/:timelineId/revisions",
  mutation(createRevision)
);

timelinesRouter.get(
  "/projects/:projectId/timelines/:timelineId/revisions/:jobId",
  route(getRevision)
);

timelinesRouter.post(
  "/projects/:projectId/timelines/:timelineId/exports",
  mutation(createExport)
);

timelinesRouter.get("/projects/:projectId/exports/:jobId", route(getExport));

timelinesRouter.get(
  "/projects/:projectId/artifacts/:artifactId",
  route(getArtifact)
);
