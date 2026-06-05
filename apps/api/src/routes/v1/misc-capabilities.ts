import { Router } from "express";
import { mutation, route } from "@/core/adapter";
import { ApiError } from "@/core/errors";
import {
  parsePagination,
  parseRegisterAsset,
  parseUpdateAssetContext,
} from "@/lib/api/v1/schemas";
import { registerAsset, updateAssetContext } from "@/lib/api/v1/assets";
import { generateCharacterAnchor } from "@/lib/api/v1/character-anchors";
import {
  createJob,
  getAsset,
  getCompositionPlan,
  getJob,
  listCharacterAnchorAssets,
  listCompositionPlans,
  listJobs,
  saveCompositionPlan,
  updateAsset,
  type V1Asset,
} from "@/lib/api/v1/store";
import { SCHEMA, type CompositionMode, type PlannedBeat } from "@popcorn/shared/v1/types";
import type {
  CharacterConsistencyGrade,
  CharacterConsistencyReview,
} from "@popcorn/shared/types";

export const miscCapabilitiesRouter = Router();

type JsonObject = Record<string, unknown>;

const COMPOSITION_MODES = new Set<CompositionMode>([
  "asset_driven",
  "prompt_only",
  "hybrid",
]);
const REVIEW_GRADES = new Set(["pass", "needs_review", "fail"]);
const ALIGNMENT_STRATEGIES = new Set([
  "fail",
  "render_longest",
  "extend_timeline",
  "rewrite_script",
]);

function parseReviewGrade(value: unknown, field: string): CharacterConsistencyGrade {
  const grade = String(value || "needs_review");
  if (!REVIEW_GRADES.has(grade)) {
    throw new ApiError("validation_failed", `${field} must be pass, needs_review, or fail.`);
  }
  return grade as CharacterConsistencyGrade;
}

function objectBody(body: unknown): JsonObject {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError("validation_failed", "Request body must be an object.");
  }
  return body as JsonObject;
}

function requiredParam(params: Record<string, string | undefined>, name: string): string {
  const value = params[name];
  if (!value) throw new ApiError("validation_failed", `${name} is required.`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean) : [];
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseCompositionMode(value: unknown): CompositionMode {
  const mode = String(value || "hybrid");
  if (!COMPOSITION_MODES.has(mode as CompositionMode)) {
    throw new ApiError("validation_failed", "mode must be asset_driven, prompt_only, or hybrid.");
  }
  return mode as CompositionMode;
}

function parsePlannedBeats(body: JsonObject, targetLengthSec: number): PlannedBeat[] {
  const plannedBeats = body.plannedBeats;
  if (Array.isArray(plannedBeats)) {
    return plannedBeats.map((beat, index) => {
      if (!beat || typeof beat !== "object" || Array.isArray(beat)) {
        throw new ApiError("validation_failed", `plannedBeats[${index}] must be an object.`);
      }
      const item = beat as JsonObject;
      const name = optionalString(item.name) ?? `Beat ${index + 1}`;
      const intent = optionalString(item.intent) ?? name;
      const assetStrategy = String(item.assetStrategy || "use_existing");
      if (!["use_existing", "generate_image", "generate_video"].includes(assetStrategy)) {
        throw new ApiError(
          "validation_failed",
          `plannedBeats[${index}].assetStrategy is invalid.`
        );
      }
      return {
        name,
        intent,
        durationSec: numberOrDefault(item.durationSec, Math.max(1, targetLengthSec / plannedBeats.length)),
        assetStrategy: assetStrategy as PlannedBeat["assetStrategy"],
        requiredAssetIds: stringArray(item.requiredAssetIds),
        generatedAssetJobIds: stringArray(item.generatedAssetJobIds),
      };
    });
  }

  return [
    {
      name: "Primary cut",
      intent: optionalString(body.goal) ?? "Create a video from the project brief and assets.",
      durationSec: targetLengthSec,
      assetStrategy: stringArray(body.assetIds).length ? "use_existing" : "generate_video",
      requiredAssetIds: stringArray(body.assetIds),
      generatedAssetJobIds: [],
    },
  ];
}

function characterAnchorFor(asset: V1Asset) {
  return {
    id: asset.id,
    assetId: asset.id,
    name: asset.userContext?.characterNames?.[0] ?? asset.userContext?.title ?? asset.filename,
    description: asset.userContext?.description ?? asset.context?.summary ?? "",
    status: asset.status,
    asset,
  };
}

function parseReview(body: unknown): CharacterConsistencyReview {
  const input = objectBody(body);
  const review: CharacterConsistencyReview = {
    identity: parseReviewGrade(input.identity, "identity"),
    wardrobe: parseReviewGrade(input.wardrobe, "wardrobe"),
    style: parseReviewGrade(input.style, "style"),
    temporal:
      input.temporal === undefined ? undefined : parseReviewGrade(input.temporal, "temporal"),
    notes: optionalString(input.notes) ?? "",
  };
  return review;
}

miscCapabilitiesRouter.get(
  "/projects/:projectId/compositions",
  route(async ({ auth, req }, params) => {
    const projectId = requiredParam(params, "projectId");
    const { limit, cursor } = parsePagination(req.searchParams);
    const { items, nextCursor } = await listCompositionPlans(
      auth.workspaceId,
      projectId,
      limit,
      cursor
    );
    return {
      status: 200,
      body: { compositions: items, pagination: { limit, nextCursor } },
    };
  })
);

miscCapabilitiesRouter.post(
  "/projects/:projectId/compositions",
  mutation(async ({ auth, body }, params) => {
    const projectId = requiredParam(params, "projectId");
    const input = objectBody(body);
    const now = new Date().toISOString();
    const targetLengthSec = numberOrDefault(input.targetLengthSec, 30);
    const plannedBeats = parsePlannedBeats(input, targetLengthSec);
    const readyAssetIds = [
      ...new Set(plannedBeats.flatMap((beat) => beat.requiredAssetIds ?? [])),
    ];
    const composition = {
      // Placeholder; saveCompositionPlan omits it and the DB assigns the id,
      // returned as `saved.id`.
      id: "",
      schemaVersion: SCHEMA.composition,
      projectId,
      briefVersionId: optionalString(input.briefVersionId) ?? "",
      mode: parseCompositionMode(input.mode),
      status: "ready_for_timeline" as const,
      plannedBeats,
      generatedAssetJobIds: [
        ...new Set(plannedBeats.flatMap((beat) => beat.generatedAssetJobIds ?? [])),
      ],
      readyAssetIds,
      narrationStrategy: input.narrationStrategy as never,
      createdAt: now,
      updatedAt: now,
    };
    const saved = await saveCompositionPlan(auth.workspaceId, composition);
    const job = await createJob({
      workspaceId: auth.workspaceId,
      projectId,
      type: "composition",
      status: "succeeded",
      payload: input,
      result: { compositionId: saved.id },
    });
    return { status: 201, body: { composition: saved, jobs: [job] } };
  })
);

miscCapabilitiesRouter.get(
  "/projects/:projectId/compositions/:compositionId",
  route(async ({ auth }, params) => {
    const projectId = requiredParam(params, "projectId");
    const compositionId = requiredParam(params, "compositionId");
    const composition = await getCompositionPlan(auth.workspaceId, projectId, compositionId);
    const { items: jobs } = await listJobs(auth.workspaceId, projectId, "composition", 100, null);
    return {
      status: 200,
      body: {
        composition,
        jobs: jobs.filter((job) => {
          const result = job.result as { compositionId?: string } | null;
          return result?.compositionId === compositionId;
        }),
      },
    };
  })
);

miscCapabilitiesRouter.get(
  "/projects/:projectId/characters",
  route(async ({ auth, req }, params) => {
    const projectId = requiredParam(params, "projectId");
    const { limit, cursor } = parsePagination(req.searchParams);
    const { items, nextCursor } = await listCharacterAnchorAssets(
      auth.workspaceId,
      projectId,
      limit,
      cursor
    );
    return {
      status: 200,
      body: {
        characterAnchors: items.map(characterAnchorFor),
        pagination: { limit, nextCursor },
      },
    };
  })
);

miscCapabilitiesRouter.post(
  "/projects/:projectId/characters",
  mutation(async ({ auth, body }, params) => {
    const projectId = requiredParam(params, "projectId");
    const input = objectBody(body);
    const name = optionalString(input.name);
    if (!name) throw new ApiError("validation_failed", "name is required.");
    const asset = await registerAsset(auth, projectId, {
      source: {
        type: "remote_url",
        url: `https://popcornready.local/character-anchors/${encodeURIComponent(name)}`,
      },
      kind: "image",
      filename: `${name.replace(/[^a-zA-Z0-9._-]/g, "_")}.character_anchor`,
      context: {
        summary: optionalString(input.identityInvariants) ?? optionalString(input.description),
        recommendedRoles: ["character_anchor"],
      },
      userContext: {
        title: name,
        description: optionalString(input.description),
        characterNames: [name],
        intendedUse: ["character_reference"],
        tags: ["character_anchor"],
      },
    });
    return { status: 201, body: { characterAnchor: characterAnchorFor(asset) } };
  })
);

miscCapabilitiesRouter.patch(
  "/projects/:projectId/characters/:characterId",
  mutation(async ({ auth, body }, params) => {
    const projectId = requiredParam(params, "projectId");
    const characterId = requiredParam(params, "characterId");
    const input = objectBody(body);
    const asset = await updateAssetContext(auth, projectId, characterId, {
      context: {
        summary: optionalString(input.identityInvariants) ?? optionalString(input.description),
        recommendedRoles: ["character_anchor"],
      },
      userContext: {
        title: optionalString(input.name),
        description: optionalString(input.description),
        characterNames: optionalString(input.name) ? [optionalString(input.name)!] : undefined,
        intendedUse: ["character_reference"],
        tags: ["character_anchor"],
      },
    });
    return { status: 200, body: { characterAnchor: characterAnchorFor(asset) } };
  })
);

miscCapabilitiesRouter.post(
  "/projects/:projectId/characters/:characterId/references",
  mutation(async ({ auth, body }, params) => {
    const projectId = requiredParam(params, "projectId");
    const characterId = requiredParam(params, "characterId");
    const input = objectBody(body);
    const assetId = optionalString(input.assetId);
    if (!assetId) throw new ApiError("validation_failed", "assetId is required.");
    const character = await getAsset(auth.workspaceId, projectId, characterId);
    const asset = await updateAssetContext(auth, projectId, assetId, {
      context: {
        recommendedRoles: ["character_reference", optionalString(input.role) ?? "reference"],
      },
      userContext: {
        characterNames: [
          character.userContext?.characterNames?.[0] ?? character.userContext?.title ?? character.filename,
        ],
        intendedUse: ["character_reference"],
        tags: ["character_reference", characterId],
      },
    });
    return { status: 201, body: { reference: { characterId, assetId, asset } } };
  })
);

// P2 (granular generation API §3): generate / regenerate the character's
// reference likeness image (the "anchor"). Thin wrapper over the generic
// generated-assets image path with character binding + provenance; returns the
// same pollable Job envelope. Poll via GET …/generation-entrypoints/assets/:jobId.
// Idempotency-Key is honored by the shared mutation wrapper.
miscCapabilitiesRouter.post(
  "/projects/:projectId/characters/:characterId/anchors",
  mutation(async ({ auth, body }, params) => {
    const projectId = requiredParam(params, "projectId");
    const characterId = requiredParam(params, "characterId");
    return generateCharacterAnchor({ auth, projectId, characterId, body });
  })
);

miscCapabilitiesRouter.patch(
  "/projects/:projectId/assets/:assetId/character-review",
  mutation(async ({ auth, body }, params) => {
    const projectId = requiredParam(params, "projectId");
    const assetId = requiredParam(params, "assetId");
    const review = parseReview(body);
    const asset = await updateAsset(auth.workspaceId, projectId, assetId, (candidate) => {
      const binding = candidate.provenance?.characterBinding;
      if (!binding) {
        throw new ApiError(
          "validation_failed",
          "Generated asset has no character binding to review."
        );
      }
      binding.consistencyReview = review;
      candidate.context = {
        ...(candidate.context ?? {}),
        summary: review.notes || candidate.context?.summary,
        recommendedRoles: [
          ...new Set([
            ...(candidate.context?.recommendedRoles ?? []),
            "character_reference",
            `identity:${review.identity}`,
          ]),
        ],
      };
      candidate.userContext = {
        ...(candidate.userContext ?? {}),
        tags: [
          ...new Set([
            ...(candidate.userContext?.tags ?? []),
            "character_reviewed",
            `identity:${review.identity}`,
            `wardrobe:${review.wardrobe}`,
            `style:${review.style}`,
            ...(review.temporal ? [`temporal:${review.temporal}`] : []),
          ]),
        ],
      };
    });
    return { status: 200, body: { asset, review } };
  })
);

miscCapabilitiesRouter.post(
  "/projects/:projectId/uploads",
  mutation(async ({ auth, body }, params) => {
    const projectId = requiredParam(params, "projectId");
    const asset = await registerAsset(auth, projectId, parseRegisterAsset(body));
    const job = await createJob({
      workspaceId: auth.workspaceId,
      projectId,
      type: "asset_ingest",
      status: asset.status === "ready" ? "succeeded" : "queued",
      payload: body,
      result: { assetId: asset.id },
    });
    return { status: 201, body: { asset, job } };
  })
);

miscCapabilitiesRouter.post(
  "/projects/:projectId/assets/:assetId/context",
  mutation(async ({ auth, body }, params) => {
    const projectId = requiredParam(params, "projectId");
    const assetId = requiredParam(params, "assetId");
    const asset = await updateAssetContext(auth, projectId, assetId, parseUpdateAssetContext(body));
    return { status: 200, body: { asset } };
  })
);

miscCapabilitiesRouter.get(
  "/projects/:projectId/exports",
  route(async ({ auth, req }, params) => {
    const projectId = requiredParam(params, "projectId");
    const { limit, cursor } = parsePagination(req.searchParams);
    const { items, nextCursor } = await listJobs(auth.workspaceId, projectId, "export", limit, cursor);
    return { status: 200, body: { exports: items, pagination: { limit, nextCursor } } };
  })
);

miscCapabilitiesRouter.post(
  "/projects/:projectId/exports",
  mutation(async ({ auth, body, requestId }, params) => {
    const projectId = requiredParam(params, "projectId");
    const input = objectBody(body);
    const timelineId = optionalString(input.timelineId);
    if (!timelineId) {
      throw new ApiError(
        "validation_failed",
        "timelineId is required. Use /projects/:projectId/timelines/:timelineId/exports once timeline routes are mounted."
      );
    }
    const job = await createJob({
      workspaceId: auth.workspaceId,
      projectId,
      requestId,
      type: "export",
      status: "queued",
      payload: input,
      result: { timelineId },
    });
    return { status: 202, body: { job } };
  })
);

miscCapabilitiesRouter.get(
  "/projects/:projectId/exports/:jobId",
  route(async ({ auth }, params) => {
    const projectId = requiredParam(params, "projectId");
    const jobId = requiredParam(params, "jobId");
    const job = await getJob(auth.workspaceId, projectId, jobId);
    if (job.type !== "export") throw new ApiError("not_found", `Export not found: ${jobId}`);
    return { status: 200, body: { job } };
  })
);

miscCapabilitiesRouter.post(
  "/projects/:projectId/audio-alignments",
  mutation(async ({ auth, body, requestId }, params) => {
    const projectId = requiredParam(params, "projectId");
    const input = objectBody(body);
    const strategy = String(input.strategy || "render_longest");
    if (!ALIGNMENT_STRATEGIES.has(strategy)) {
      throw new ApiError(
        "validation_failed",
        "strategy must be one of: fail, render_longest, extend_timeline, rewrite_script."
      );
    }
    const timelineDurationSec = numberOrDefault(input.timelineDurationSec, 0);
    const audioDurationSec = numberOrDefault(input.audioDurationSec, 0);
    const maxDeltaSec = numberOrDefault(input.maxDeltaSec, 1);
    const comparison =
      timelineDurationSec > 0 && audioDurationSec > 0
        ? {
            timelineDurationSec,
            audioDurationSec,
            deltaSec: Math.round(Math.abs(timelineDurationSec - audioDurationSec) * 100) / 100,
            maxDeltaSec,
            withinThreshold: Math.abs(timelineDurationSec - audioDurationSec) <= maxDeltaSec,
          }
        : null;
    const job = await createJob({
      workspaceId: auth.workspaceId,
      projectId,
      requestId,
      type: "audio_alignment",
      status: comparison?.withinThreshold ? "succeeded" : "queued",
      payload: input,
      result: { strategy, comparison },
    });
    return { status: 202, body: { job, strategy, comparison } };
  })
);

miscCapabilitiesRouter.get(
  "/projects/:projectId/audio-alignments/:jobId",
  route(async ({ auth }, params) => {
    const projectId = requiredParam(params, "projectId");
    const jobId = requiredParam(params, "jobId");
    const job = await getJob(auth.workspaceId, projectId, jobId);
    if (job.type !== "audio_alignment") {
      throw new ApiError("not_found", `Audio alignment job not found: ${jobId}`);
    }
    return { status: 200, body: { job } };
  })
);
