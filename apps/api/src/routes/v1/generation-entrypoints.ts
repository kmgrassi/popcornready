import { Router } from "express";
import { mutation, route } from "@/core/adapter";
import { ApiError } from "@/core/errors";
import { createGeneratedAsset, getGeneratedAssetJob } from "@/lib/api/v1/generated-assets";
import { AuthContext } from "@/lib/api/v1/auth";
import {
  createBriefVersion,
  getProject as getApiProject,
  listAssets as listApiAssets,
  listBriefVersions,
  V1Asset as ApiAsset,
} from "@/lib/api/v1/store";
import { parseBrief } from "@/lib/api/v1/schemas";
import { createGenerationJob, runGenerationJob } from "@/lib/v1/generation";
import { Actor } from "@/lib/v1/actor";
import { getStore, V1Store } from "@/lib/v1/store";
import { SCHEMA, GenerationRequest, V1Asset } from "@popcorn/shared/v1/types";

export const generationEntrypointsRouter = Router();

const PAGE_SIZE = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireProjectId(params: Record<string, string | undefined>): string {
  if (!params.projectId) {
    throw new ApiError("validation_failed", "projectId is required.");
  }
  return params.projectId;
}

function actorForAuth(auth: AuthContext): Actor {
  return {
    actorId: auth.actor.id,
    workspaceId: auth.workspaceId,
    isLocal: auth.isLocal,
  };
}

function assetUrl(asset: ApiAsset): string {
  if (asset.remoteUrl) return asset.remoteUrl;
  if (asset.storageKey) return `/${asset.storageKey.replace(/^media\//, "")}`;
  return `/assets/${asset.id}/${asset.filename}`;
}

function assetSource(asset: ApiAsset): V1Asset["source"] {
  switch (asset.source.type) {
    case "generated":
      return "generated";
    case "local_path":
      return "local_path";
    case "remote_url":
      return "remote_url";
    case "multipart_upload":
    default:
      return "upload";
  }
}

function generatedAssetJobId(asset: ApiAsset): string | undefined {
  const provenance = asset.provenance as { generatedAssetJobId?: string } | undefined;
  return provenance?.generatedAssetJobId;
}

function toGenerationAsset(
  asset: ApiAsset,
  generatedJobIdByAssetId: Map<string, string> = new Map()
): V1Asset {
  const jobId = generatedJobIdByAssetId.get(asset.id) ?? generatedAssetJobId(asset);
  return {
    id: asset.id,
    schemaVersion: SCHEMA.asset,
    projectId: asset.projectId,
    workspaceId: asset.workspaceId,
    kind: asset.kind,
    status: asset.status,
    filename: asset.filename,
    url: assetUrl(asset),
    durationSec: asset.durationSec ?? (asset.kind === "image" ? 4 : 8),
    description: asset.context?.summary,
    userContext: asset.userContext,
    agentContext: asset.agentContext,
    assetKnowledge: asset.assetKnowledge,
    clipUnderstanding: asset.clipUnderstanding,
    source: assetSource(asset),
    ...(jobId ? { generatedAssetJobId: jobId } : {}),
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
  };
}

async function allApiAssets(workspaceId: string, projectId: string): Promise<ApiAsset[]> {
  const assets: ApiAsset[] = [];
  let cursor: string | null = null;
  do {
    const page = await listApiAssets(workspaceId, projectId, PAGE_SIZE, cursor);
    assets.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return assets;
}

async function mirrorProjectInputs(args: {
  auth: AuthContext;
  projectId: string;
  store: V1Store;
  generatedJobIdByAssetId?: Map<string, string>;
}): Promise<void> {
  const { auth, projectId, store } = args;
  const generatedJobIdByAssetId = args.generatedJobIdByAssetId ?? new Map();
  const project = await getApiProject(auth.workspaceId, projectId);
  await store.saveProject({
    id: project.id,
    schemaVersion: SCHEMA.project,
    workspaceId: project.workspaceId,
    name: project.name,
    status: project.status,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  });

  let cursor: string | null = null;
  do {
    const page = await listBriefVersions(auth.workspaceId, projectId, PAGE_SIZE, cursor);
    for (const brief of page.items) {
      await store.saveBriefVersion({
        id: brief.id,
        schemaVersion: SCHEMA.briefVersion,
        projectId: brief.projectId,
        brief: brief.brief,
        createdAt: brief.createdAt,
      });
    }
    cursor = page.nextCursor;
  } while (cursor);

  for (const asset of await allApiAssets(auth.workspaceId, projectId)) {
    await store.saveAsset(toGenerationAsset(asset, generatedJobIdByAssetId));
  }
}

function promptBriefFromBody(body: unknown) {
  if (!isRecord(body)) {
    throw new ApiError("validation_failed", "Request body must be an object.");
  }
  const source = isRecord(body.brief)
    ? body.brief
    : {
        goal: body.goal,
        targetLengthSec: body.targetLengthSec ?? 30,
        aspectRatio: body.aspectRatio ?? "9:16",
        style: body.style ?? "fast-paced social ad",
        audience: body.audience,
        platform: body.platform,
        format: body.format,
        narration: body.narration,
        constraints: body.constraints,
      };
  return parseBrief(source, "brief");
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function generationBody(
  body: unknown,
  briefVersionId: string,
  fallbackAssetIds: string[]
): GenerationRequest {
  const source = isRecord(body) ? body : {};
  return {
    briefVersionId,
    assetIds: stringArray(source.assetIds).length
      ? stringArray(source.assetIds)
      : fallbackAssetIds,
    compositionId: source.compositionId ? String(source.compositionId) : undefined,
    mode:
      source.mode === "asset_driven" || source.mode === "prompt_only" || source.mode === "hybrid"
        ? source.mode
        : undefined,
    allowGeneratedGapFill:
      typeof source.allowGeneratedGapFill === "boolean"
        ? source.allowGeneratedGapFill
        : undefined,
    variantCount: source.variantCount === undefined ? 1 : Number(source.variantCount),
    showCaptions:
      typeof source.showCaptions === "boolean" ? source.showCaptions : undefined,
  };
}

function resultAssetIds(result: unknown): string[] {
  if (!isRecord(result)) return [];
  const job = isRecord(result.job) ? result.job : undefined;
  const jobResult = job && isRecord(job.result) ? job.result : undefined;
  return stringArray(jobResult?.assetIds);
}

function defaultSeedAssetRequest(body: unknown, prompt: string): Record<string, unknown> {
  const source = isRecord(body) ? body : {};
  const seed = isRecord(source.seedAsset) ? source.seedAsset : {};
  return {
    kind: seed.kind ?? "image",
    provider: seed.provider ?? source.provider ?? "openai",
    prompt: seed.prompt ?? prompt,
    description: seed.description ?? source.description ?? prompt,
    durationSec: seed.durationSec ?? 4,
    size: seed.size ?? source.size,
    quality: seed.quality ?? source.quality,
    preflightReviewIterations: seed.preflightReviewIterations ?? source.preflightReviewIterations,
  };
}

interface SeededGenerationAssets {
  assetIds: string[];
  generatedJobIdByAssetId: Map<string, string>;
}

async function seedGeneratedAssets(args: {
  auth: AuthContext;
  projectId: string;
  body: unknown;
  briefGoal: string;
}): Promise<SeededGenerationAssets> {
  const empty = { assetIds: [], generatedJobIdByAssetId: new Map<string, string>() };
  if (!isRecord(args.body)) return empty;
  if (args.body.compositionId) return empty;
  if (stringArray(args.body.assetIds).length > 0) return empty;

  const source = Array.isArray(args.body.seedAssets)
    ? args.body.seedAssets
    : [defaultSeedAssetRequest(args.body, args.briefGoal)];

  const assetIds: string[] = [];
  const generatedJobIdByAssetId = new Map<string, string>();
  for (const seed of source) {
    const result = await createGeneratedAsset({
      auth: args.auth,
      projectId: args.projectId,
      body: seed,
    });
    const seededAssetIds = resultAssetIds(result.body);
    assetIds.push(...seededAssetIds);
    const job = isRecord(result.body.job) ? result.body.job : undefined;
    const jobId = job?.id ? String(job.id) : undefined;
    if (jobId) {
      for (const assetId of seededAssetIds) {
        generatedJobIdByAssetId.set(assetId, jobId);
      }
    }
  }
  return { assetIds, generatedJobIdByAssetId };
}

async function createAndMaybeRunGeneration(args: {
  auth: AuthContext;
  requestId: string;
  idempotencyKey: string | null;
  projectId: string;
  body: unknown;
  briefVersionId: string;
  assetIds: string[];
  generatedJobIdByAssetId?: Map<string, string>;
}) {
  const store = getStore();
  await mirrorProjectInputs({
    auth: args.auth,
    projectId: args.projectId,
    store,
    generatedJobIdByAssetId: args.generatedJobIdByAssetId,
  });
  const generationJob = await createGenerationJob({
    store,
    actor: actorForAuth(args.auth),
    projectId: args.projectId,
    body: generationBody(args.body, args.briefVersionId, args.assetIds),
    idempotencyKey: args.idempotencyKey ?? undefined,
    requestId: args.requestId,
  });

  const shouldRun =
    isRecord(args.body) && args.body.runNow === false ? false : true;
  const job = shouldRun ? await runGenerationJob(store, generationJob.id) : generationJob;
  return { status: 202, body: { job } };
}

generationEntrypointsRouter.post(
  "/projects/:projectId/generation-entrypoints/prompt",
  mutation(async ({ auth, body, req, requestId }, params) => {
    const projectId = requireProjectId(params);
    const brief = promptBriefFromBody(body);
    const { briefVersion } = await createBriefVersion(auth.workspaceId, projectId, brief);
    const suppliedAssetIds = isRecord(body) ? stringArray(body.assetIds) : [];
    const seeded = await seedGeneratedAssets({
      auth,
      projectId,
      body,
      briefGoal: brief.goal,
    });
    return createAndMaybeRunGeneration({
      auth,
      requestId,
      idempotencyKey: req.header("Idempotency-Key"),
      projectId,
      body,
      briefVersionId: briefVersion.id,
      assetIds: suppliedAssetIds.length ? suppliedAssetIds : seeded.assetIds,
      generatedJobIdByAssetId: seeded.generatedJobIdByAssetId,
    });
  })
);

generationEntrypointsRouter.post(
  "/projects/:projectId/generation-entrypoints/uploaded-footage",
  mutation(async ({ auth, body, req, requestId }, params) => {
    const projectId = requireProjectId(params);
    if (!isRecord(body)) {
      throw new ApiError("validation_failed", "Request body must be an object.");
    }
    const briefVersionId = String(body.briefVersionId || "").trim();
    if (!briefVersionId) {
      throw new ApiError("brief_missing", "briefVersionId is required.", {
        fields: [{ path: "briefVersionId", message: "Required." }],
      });
    }
    const assetIds = stringArray(body.assetIds);
    if (assetIds.length === 0) {
      throw new ApiError("validation_failed", "assetIds is required.", {
        fields: [{ path: "assetIds", message: "Provide at least one ready visual asset." }],
      });
    }
    return createAndMaybeRunGeneration({
      auth,
      requestId,
      idempotencyKey: req.header("Idempotency-Key"),
      projectId,
      body,
      briefVersionId,
      assetIds,
    });
  })
);

generationEntrypointsRouter.post(
  "/projects/:projectId/generation-entrypoints/assets",
  mutation(async ({ auth, body }, params) => {
    const projectId = requireProjectId(params);
    return createGeneratedAsset({ auth, projectId, body });
  })
);

generationEntrypointsRouter.get(
  "/projects/:projectId/generation-entrypoints/assets/:jobId",
  route(async ({ auth }, params) => {
    const projectId = requireProjectId(params);
    if (!params.jobId) {
      throw new ApiError("validation_failed", "jobId is required.");
    }
    return getGeneratedAssetJob({ auth, projectId, jobId: params.jobId });
  })
);

generationEntrypointsRouter.post(
  "/projects/:projectId/generation-entrypoints/revisions",
  mutation(async () => {
    throw new ApiError(
      "not_implemented",
      "Timeline revision entrypoints move to /api/v1/projects/:projectId/timelines/:timelineId/revisions."
    );
  })
);
