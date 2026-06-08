// P2 routes: per-beat media tools (granular-generation-api.md §3, §5 P2).
//
//   POST /projects/:projectId/beats/:beatId/keyframe  -> per-beat still image
//   POST /projects/:projectId/beats/:beatId/clip       -> per-beat video
//   GET  /projects/:projectId/beats/:beatId/media/:jobId -> poll the Job
//
// Thin entries into the existing generated-assets primitive that record
// `beatId`/`anchorIds` provenance; all the work lives in lib/api/v1/beats.ts.
// Each generate returns the same pollable `asset_generation` Job and honors
// `Idempotency-Key` (handled by the shared `mutation()` wrapper).

import { Router } from "express";
import { mutation, route } from "@/core/adapter";
import { ApiError } from "@/core/errors";
import {
  generateBeatClip,
  generateBeatKeyframe,
  getBeatMediaJob,
} from "@/lib/api/v1/beats";

export const beatsRouter = Router();

function requiredParam(
  params: Record<string, string | undefined>,
  name: string
): string {
  const value = params[name];
  if (!value) {
    throw new ApiError("validation_failed", `${name} is required.`);
  }
  return value;
}

beatsRouter.post(
  "/projects/:projectId/beats/:beatId/keyframe",
  mutation(async ({ auth, body }, params) =>
    generateBeatKeyframe({
      auth,
      projectId: requiredParam(params, "projectId"),
      beatId: requiredParam(params, "beatId"),
      body,
    })
  )
);

beatsRouter.post(
  "/projects/:projectId/beats/:beatId/clip",
  mutation(async ({ auth, body }, params) =>
    generateBeatClip({
      auth,
      projectId: requiredParam(params, "projectId"),
      beatId: requiredParam(params, "beatId"),
      body,
    })
  )
);

beatsRouter.get(
  "/projects/:projectId/beats/:beatId/media/:jobId",
  route(async ({ auth }, params) =>
    getBeatMediaJob({
      auth,
      projectId: requiredParam(params, "projectId"),
      jobId: requiredParam(params, "jobId"),
    })
  )
);
