// Storyboard editing operations (PR6 — Storyboard editing).
//
// The storyboard view edits a project's EditPlan (Scenes -> Beats) and can
// regenerate a single beat's sketch tile. This module hosts the regenerate
// action so the route stays thin and the calling point into the PR2 storyboard
// tile generator is a single, well-marked seam.

import type { EditPlan } from "@popcorn/shared/types";
import type { AuthContext } from "./auth";
import { ApiError, notFound } from "./errors";
import { getProject } from "./store";

export interface RegenerateBeatTileInput {
  auth: AuthContext;
  projectId: string;
  beatId: string;
}

export interface RegenerateBeatTileResult {
  status: number;
  body: {
    projectId: string;
    beatId: string;
    sceneId: string;
    // The newly generated storyboard tile asset id, once PR2's generator is
    // wired. Null until then (the endpoint contract is live; the generation is
    // a TODO calling point — see below).
    storyboardAssetId: string | null;
    status: "regenerated" | "queued" | "pending_generator";
  };
}

function findBeatScene(
  plan: EditPlan,
  beatId: string
): { sceneId: string } | null {
  const scenes = plan.scenes ?? [];
  for (const scene of scenes) {
    if (scene.beats.some((beat) => beat.id === beatId)) {
      return { sceneId: scene.id };
    }
  }
  // Fall back to the flat beats view for plans not yet migrated to scenes.
  if (plan.beats?.some((beat) => beat.id === beatId)) {
    return { sceneId: "" };
  }
  return null;
}

// Re-run storyboard tile generation for ONE beat (recompute-affected only). This
// recomputes a single beat's `beat_storyboard` asset and nothing else.
export async function regenerateBeatTile(
  input: RegenerateBeatTileInput
): Promise<RegenerateBeatTileResult> {
  const { auth, projectId, beatId } = input;

  const project = await getProject(auth.workspaceId, projectId);
  if (!project.plan) {
    throw notFound(`Project has no storyboard plan: ${projectId}`);
  }

  const located = findBeatScene(project.plan, beatId);
  if (!located) {
    throw new ApiError("validation_failed", `Beat not found in plan: ${beatId}`);
  }

  // TODO(storyboard PR2): call the storyboard tile generator for THIS beat only.
  // The generator composes scene context + beat intent (+ sketch anchors), emits
  // a `beat_storyboard` asset depicting { beatId }, pools it, and returns its id.
  // Until PR2 lands in this branch, the endpoint contract is live and returns
  // `pending_generator` so the UI seam is exercisable end to end.
  //
  //   const asset = await generateBeatStoryboardTile({ auth, project, beatId,
  //     sceneId: located.sceneId });
  //   return { ..., storyboardAssetId: asset.id, status: "regenerated" };

  return {
    status: 202,
    body: {
      projectId,
      beatId,
      sceneId: located.sceneId,
      storyboardAssetId: null,
      status: "pending_generator",
    },
  };
}
