import { Router } from "express";
import { mutation, route } from "@/core/adapter";
import { ApiError } from "@/core/errors";
import { errorResponse, getIdempotencyKey, loadProject } from "@/lib/agent-api/http";
import { agentApiStore } from "@/lib/agent-api/jobs";
import { ApiError as AgentApiError, toErrorEnvelope } from "@/lib/agent-api/runtime";
import type { Artifact, Job, JobType } from "@/lib/agent-api/types";
import { type ExportOptions, runExportJob, runRevisionJob } from "@/lib/agent-api/workers";
import type { ApiResult, HandlerCtx } from "@/lib/api/v1/handler";
import type { Project } from "@popcorn/shared/types";
import {
  type AssembleRequest,
  resolveAssemble,
  runAssemble,
  runTimelineCritique,
} from "@/lib/v1/assemble";
import { resolveActorFromRequest } from "@/lib/v1/actor";
import { assetToClip } from "@/lib/v1/generation/prepare";
import { createLogger } from "@/lib/v1/logger";
import { redactMessage } from "@/lib/v1/redact";
import { getStore } from "@/lib/v1/store";
import { createHash } from "crypto";
import type { Actor } from "@/lib/v1/actor";
import type { V1Store } from "@/lib/v1/store";
import {
  type Job as V1Job,
  type JobType as V1JobType,
  SCHEMA,
  type VersionedTimeline,
} from "@popcorn/shared/v1/types";

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
    showCaptions: typeof input.showCaptions === "boolean" ? input.showCaptions : undefined,
  };
}

async function requireV1Project(
  store: V1Store,
  workspaceId: string,
  projectId: string
) {
  const project = await store.getProject(projectId);
  if (!project || project.workspaceId !== workspaceId || project.status === "deleted") {
    throw new AgentApiError("not_found", 404, `Project not found: ${projectId}`);
  }
  return project;
}

async function requireV1TimelineProject(
  store: V1Store,
  input: { workspaceId: string; projectId: string; timelineId: string }
): Promise<{ project: Project; timeline: VersionedTimeline }> {
  const v1Project = await requireV1Project(store, input.workspaceId, input.projectId);
  const timeline = await store.getTimeline(input.timelineId);
  if (!timeline || timeline.projectId !== input.projectId) {
    throw new AgentApiError("timeline_not_found", 404, "Timeline not found.", {
      timelineId: input.timelineId,
    });
  }

  const referencedClipIds = new Set(timeline.segments.map((segment) => segment.clipId));
  const clips = (await store.listAssets(input.projectId))
    .filter((asset) => referencedClipIds.has(asset.id))
    .map(assetToClip);

  return {
    timeline,
    project: {
      id: v1Project.id,
      goal: v1Project.name,
      plan: null,
      timeline: {
        aspectRatio: timeline.aspectRatio,
        fps: timeline.fps,
        ...(timeline.showCaptions === undefined ? {} : { showCaptions: timeline.showCaptions }),
        segments: timeline.segments,
      },
      clips,
      critic: timeline.provenance.criticReport,
      chat: [],
      updatedAt: timeline.createdAt,
    },
  };
}

async function latestTimelineForProject(
  store: V1Store,
  workspaceId: string,
  projectId: string
): Promise<VersionedTimeline | null> {
  const project = await store.getProject(projectId);
  if (!project || project.workspaceId !== workspaceId || project.status === "deleted") {
    throw new ApiError("not_found", `Project not found: ${projectId}`);
  }
  const timelines = await store.listTimelinesForProject(projectId);
  return timelines[0] ?? null;
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
  { auth, body, req, requestId }: HandlerCtx,
  params: RouteParams
): Promise<ApiResult> {
  try {
    const projectId = param(params, "projectId");
    const timelineId = param(params, "timelineId");
    const options = parseExportOptions(body);
    const store = getStore();
    const { project } = await requireV1TimelineProject(store, {
      workspaceId: auth.workspaceId,
      projectId,
      timelineId,
    });

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

// ---------------------------------------------------------------------------
// Assemble (POST /timelines) + timeline critique (POST /timelines/:id/critique)
// ---------------------------------------------------------------------------
//
// Granular generation API §3 (P3 endpoint pair). Thin wrappers over the agent's
// `selectClips` / `critique` and the v1 timeline store. They ride the same v1
// Job + GET-poll abstraction generations.ts uses (uniform async, §6.2) and
// honor Idempotency-Key (§6.3). The engine-unification is a separate later PR;
// these endpoints deliberately do not touch generation.ts.

function v1Param(params: RouteParams, name: string): string {
  const value = params[name];
  if (!value) {
    throw new ApiError("validation_failed", `${name} is required.`);
  }
  return value;
}

function bodyAssembleRequest(body: unknown): AssembleRequest {
  const input = bodyRecord(body);
  return {
    ...(typeof input.compositionId === "string" ? { compositionId: input.compositionId } : {}),
    ...(input.plan !== undefined ? { plan: input.plan } : {}),
    ...(Array.isArray(input.assetIds)
      ? { assetIds: input.assetIds.filter((id): id is string => typeof id === "string") }
      : {}),
    ...(typeof input.goal === "string" ? { goal: input.goal } : {}),
    ...(typeof input.showCaptions === "boolean" ? { showCaptions: input.showCaptions } : {}),
  };
}

// A new v1 Job row in `running` state. Workers run inline today, so the job is
// terminal by the time POST returns; the GET companion still exists so callers
// poll exactly as they will against a real async queue.
function buildV1Job(
  actor: Actor,
  projectId: string,
  type: V1JobType,
  options: { requestId?: string; idempotencyKey?: string; currentStep: string }
): V1Job {
  const now = new Date().toISOString();
  return {
    id: "",
    schemaVersion: SCHEMA.job,
    workspaceId: actor.workspaceId,
    projectId,
    ...(options.requestId ? { requestId: options.requestId } : {}),
    type,
    status: "running",
    progress: { currentStep: options.currentStep, stepStartedAt: now, percent: 0 },
    input: null,
    result: null,
    error: null,
    ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

function v1IdempotencyScope(
  actor: Actor,
  method: string,
  pathname: string,
  key: string
): string {
  return createHash("sha256")
    .update(`${actor.workspaceId}|${method}|${pathname}|${key}`)
    .digest("hex");
}

// Replay a prior job for a repeated Idempotency-Key, or run `work` and persist
// its terminal result/error onto a fresh job. Shared by assemble + critique.
async function runIdempotentV1Job<T>(args: {
  store: V1Store;
  actor: Actor;
  projectId: string;
  type: V1JobType;
  currentStep: string;
  requestId: string;
  idempotencyKey?: string;
  pathname: string;
  work: (jobId: string) => Promise<T>;
}): Promise<{ status: number; job: V1Job<unknown, T> }> {
  const { store, actor, projectId, type, requestId, idempotencyKey, pathname } = args;
  const scope = idempotencyKey
    ? v1IdempotencyScope(actor, "POST", pathname, idempotencyKey)
    : null;

  if (scope) {
    const existing = await store.getIdempotency(scope);
    if (existing) {
      const prior = await store.getJob(existing.jobId);
      if (prior && prior.projectId === projectId && prior.type === type) {
        return { status: 200, job: prior as V1Job<unknown, T> };
      }
    }
  }

  const built = buildV1Job(actor, projectId, type, {
    requestId,
    currentStep: args.currentStep,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
  const saved = await store.saveJob(built);
  let job: V1Job = { ...built, id: saved.id };

  if (scope) {
    await store.saveIdempotency(scope, {
      requestHash: scope,
      jobId: job.id,
      createdAt: new Date().toISOString(),
    });
  }

  try {
    const result = await args.work(job.id);
    job = await store.saveJob({
      ...job,
      status: "succeeded",
      progress: { ...job.progress, percent: 100 },
      result,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    const apiErr =
      err instanceof ApiError
        ? err
        : new ApiError(
            "internal_error",
            err instanceof Error ? err.message : "Internal error."
          );
    job = await store.saveJob({
      ...job,
      status: "failed",
      error: { code: apiErr.code, message: redactMessage(apiErr.message) },
      updatedAt: new Date().toISOString(),
    });
    throw apiErr;
  }
  return { status: 201, job: job as V1Job<unknown, T> };
}

async function createAssemble(
  { body, req, requestId }: HandlerCtx,
  params: RouteParams
): Promise<ApiResult> {
  const projectId = v1Param(params, "projectId");
  const actor = await resolveActorFromRequest(req);
  const logger = createLogger({
    requestId,
    workspaceId: actor.workspaceId,
    projectId,
    jobType: "generation",
  });
  const store = getStore();
  const idempotencyKey = req.header("Idempotency-Key") || undefined;

  // Resolve + validate the request up front so precondition errors (no plan/
  // composition, no ready assets, unknown composition) surface as structured
  // ApiErrors before a job is created.
  const input = await resolveAssemble(
    store,
    actor.workspaceId,
    projectId,
    bodyAssembleRequest(body)
  );

  const { status, job } = await runIdempotentV1Job({
    store,
    actor,
    projectId,
    type: "generation",
    currentStep: "selecting_clips",
    requestId,
    pathname: `/api/v1/projects/${projectId}/timelines`,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    work: (jobId) =>
      runAssemble({ store, jobId, input, projectId }).then((r) => {
        logger.info("assemble.succeeded", {
          jobId,
          timelineId: r.timelineId,
          segments: r.segmentCount,
        });
        return r;
      }),
  });

  return { status, body: { job } };
}

async function getAssemble(
  { req }: HandlerCtx,
  params: RouteParams
): Promise<ApiResult> {
  const projectId = v1Param(params, "projectId");
  const jobId = v1Param(params, "jobId");
  const actor = await resolveActorFromRequest(req);
  const store = getStore();
  const job = await store.getJob(jobId);
  if (
    !job ||
    job.projectId !== projectId ||
    job.workspaceId !== actor.workspaceId ||
    job.type !== "generation"
  ) {
    throw new ApiError("not_found", `Assemble job not found: ${jobId}`);
  }
  return { status: 200, body: { job } };
}

async function createTimelineCritique(
  { req, requestId }: HandlerCtx,
  params: RouteParams
): Promise<ApiResult> {
  const projectId = v1Param(params, "projectId");
  const timelineId = v1Param(params, "timelineId");
  const actor = await resolveActorFromRequest(req);
  const store = getStore();
  const idempotencyKey = req.header("Idempotency-Key") || undefined;

  const { status, job } = await runIdempotentV1Job({
    store,
    actor,
    projectId,
    type: "revision",
    currentStep: "critiquing_timeline",
    requestId,
    pathname: `/api/v1/projects/${projectId}/timelines/${timelineId}/critique`,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    work: () =>
      runTimelineCritique({
        store,
        workspaceId: actor.workspaceId,
        projectId,
        timelineId,
      }),
  });

  return { status, body: { job } };
}

async function getTimelineCritique(
  { req }: HandlerCtx,
  params: RouteParams
): Promise<ApiResult> {
  const projectId = v1Param(params, "projectId");
  const jobId = v1Param(params, "jobId");
  const actor = await resolveActorFromRequest(req);
  const store = getStore();
  const job = await store.getJob(jobId);
  if (
    !job ||
    job.projectId !== projectId ||
    job.workspaceId !== actor.workspaceId ||
    job.type !== "revision"
  ) {
    throw new ApiError("not_found", `Critique job not found: ${jobId}`);
  }
  return { status: 200, body: { job } };
}

async function getLatestTimeline(
  { auth }: HandlerCtx,
  params: RouteParams
): Promise<ApiResult> {
  const projectId = v1Param(params, "projectId");
  const store = getStore();
  const timeline = await latestTimelineForProject(store, auth.workspaceId, projectId);
  return { status: 200, body: { timeline } };
}

timelinesRouter.post("/projects/:projectId/timelines", mutation(createAssemble));
timelinesRouter.get(
  "/projects/:projectId/timelines/latest",
  route(getLatestTimeline)
);
timelinesRouter.get(
  "/projects/:projectId/timelines/assemble/:jobId",
  route(getAssemble)
);
timelinesRouter.post(
  "/projects/:projectId/timelines/:timelineId/critique",
  mutation(createTimelineCritique)
);
timelinesRouter.get(
  "/projects/:projectId/timelines/critique/:jobId",
  route(getTimelineCritique)
);

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
