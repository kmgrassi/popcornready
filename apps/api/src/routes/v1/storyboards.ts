import { Router } from "express";
import { mutation, route } from "@/core/adapter";
import { ApiError } from "@/core/errors";
import {
  createBeat,
  createPanel,
  createScene,
  createStoryboard,
  deleteBeat,
  deletePanel,
  deleteScene,
  deleteStoryboard,
  getStoryboard,
  listBeats,
  listPanels,
  listScenes,
  listStoryboards,
  parseBeatInput,
  parsePanelInput,
  parseSceneInput,
  parseStoryboardInput,
  updateBeat,
  updatePanel,
  updateScene,
  updateStoryboard,
} from "@/lib/api/v1/storyboards";

export const storyboardsRouter = Router();

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

storyboardsRouter.get(
  "/projects/:projectId/storyboards",
  route(async ({ auth }, params) => {
    const storyboards = await listStoryboards({
      auth,
      projectId: requiredParam(params, "projectId"),
    });
    return { status: 200, body: { storyboards } };
  })
);

storyboardsRouter.post(
  "/projects/:projectId/storyboards",
  mutation(async ({ auth, body }, params) => {
    const storyboard = await createStoryboard({
      auth,
      projectId: requiredParam(params, "projectId"),
      data: parseStoryboardInput(body),
    });
    return { status: 201, body: { storyboard } };
  })
);

storyboardsRouter.get(
  "/projects/:projectId/storyboards/:storyboardId",
  route(async ({ auth }, params) => {
    const storyboard = await getStoryboard({
      auth,
      projectId: requiredParam(params, "projectId"),
      storyboardId: requiredParam(params, "storyboardId"),
    });
    return { status: 200, body: { storyboard } };
  })
);

storyboardsRouter.put(
  "/projects/:projectId/storyboards/:storyboardId",
  mutation(async ({ auth, body }, params) => {
    const storyboard = await updateStoryboard({
      auth,
      projectId: requiredParam(params, "projectId"),
      storyboardId: requiredParam(params, "storyboardId"),
      data: parseStoryboardInput(body),
    });
    return { status: 200, body: { storyboard } };
  })
);

storyboardsRouter.delete(
  "/projects/:projectId/storyboards/:storyboardId",
  mutation(async ({ auth }, params) => {
    await deleteStoryboard({
      auth,
      projectId: requiredParam(params, "projectId"),
      storyboardId: requiredParam(params, "storyboardId"),
    });
    return { status: 200, body: { ok: true } };
  })
);

storyboardsRouter.get(
  "/projects/:projectId/storyboards/:storyboardId/scenes",
  route(async ({ auth }, params) => {
    const scenes = await listScenes({
      auth,
      projectId: requiredParam(params, "projectId"),
      storyboardId: requiredParam(params, "storyboardId"),
    });
    return { status: 200, body: { scenes } };
  })
);

storyboardsRouter.post(
  "/projects/:projectId/storyboards/:storyboardId/scenes",
  mutation(async ({ auth, body }, params) => {
    const scene = await createScene({
      auth,
      projectId: requiredParam(params, "projectId"),
      storyboardId: requiredParam(params, "storyboardId"),
      data: parseSceneInput(body),
    });
    return { status: 201, body: { scene } };
  })
);

storyboardsRouter.put(
  "/projects/:projectId/storyboards/:storyboardId/scenes/:sceneId",
  mutation(async ({ auth, body }, params) => {
    const scene = await updateScene({
      auth,
      projectId: requiredParam(params, "projectId"),
      storyboardId: requiredParam(params, "storyboardId"),
      sceneId: requiredParam(params, "sceneId"),
      data: parseSceneInput(body),
    });
    return { status: 200, body: { scene } };
  })
);

storyboardsRouter.delete(
  "/projects/:projectId/storyboards/:storyboardId/scenes/:sceneId",
  mutation(async ({ auth }, params) => {
    await deleteScene({
      auth,
      projectId: requiredParam(params, "projectId"),
      storyboardId: requiredParam(params, "storyboardId"),
      sceneId: requiredParam(params, "sceneId"),
    });
    return { status: 200, body: { ok: true } };
  })
);

storyboardsRouter.get(
  "/projects/:projectId/storyboards/:storyboardId/scenes/:sceneId/beats",
  route(async ({ auth }, params) => {
    const beats = await listBeats({
      auth,
      projectId: requiredParam(params, "projectId"),
      storyboardId: requiredParam(params, "storyboardId"),
      sceneId: requiredParam(params, "sceneId"),
    });
    return { status: 200, body: { beats } };
  })
);

storyboardsRouter.post(
  "/projects/:projectId/storyboards/:storyboardId/scenes/:sceneId/beats",
  mutation(async ({ auth, body }, params) => {
    const beat = await createBeat({
      auth,
      projectId: requiredParam(params, "projectId"),
      storyboardId: requiredParam(params, "storyboardId"),
      sceneId: requiredParam(params, "sceneId"),
      data: parseBeatInput(body),
    });
    return { status: 201, body: { beat } };
  })
);

storyboardsRouter.put(
  "/projects/:projectId/storyboards/:storyboardId/scenes/:sceneId/beats/:beatId",
  mutation(async ({ auth, body }, params) => {
    const beat = await updateBeat({
      auth,
      projectId: requiredParam(params, "projectId"),
      storyboardId: requiredParam(params, "storyboardId"),
      sceneId: requiredParam(params, "sceneId"),
      beatId: requiredParam(params, "beatId"),
      data: parseBeatInput(body),
    });
    return { status: 200, body: { beat } };
  })
);

storyboardsRouter.delete(
  "/projects/:projectId/storyboards/:storyboardId/scenes/:sceneId/beats/:beatId",
  mutation(async ({ auth }, params) => {
    await deleteBeat({
      auth,
      projectId: requiredParam(params, "projectId"),
      storyboardId: requiredParam(params, "storyboardId"),
      sceneId: requiredParam(params, "sceneId"),
      beatId: requiredParam(params, "beatId"),
    });
    return { status: 200, body: { ok: true } };
  })
);

storyboardsRouter.get(
  "/projects/:projectId/storyboards/:storyboardId/scenes/:sceneId/beats/:beatId/panels",
  route(async ({ auth }, params) => {
    const panels = await listPanels({
      auth,
      projectId: requiredParam(params, "projectId"),
      storyboardId: requiredParam(params, "storyboardId"),
      sceneId: requiredParam(params, "sceneId"),
      beatId: requiredParam(params, "beatId"),
    });
    return { status: 200, body: { panels } };
  })
);

storyboardsRouter.post(
  "/projects/:projectId/storyboards/:storyboardId/scenes/:sceneId/beats/:beatId/panels",
  mutation(async ({ auth, body }, params) => {
    const panel = await createPanel({
      auth,
      projectId: requiredParam(params, "projectId"),
      storyboardId: requiredParam(params, "storyboardId"),
      sceneId: requiredParam(params, "sceneId"),
      beatId: requiredParam(params, "beatId"),
      data: parsePanelInput(body),
    });
    return { status: 201, body: { panel } };
  })
);

storyboardsRouter.put(
  "/projects/:projectId/storyboards/:storyboardId/scenes/:sceneId/beats/:beatId/panels/:panelId",
  mutation(async ({ auth, body }, params) => {
    const panel = await updatePanel({
      auth,
      projectId: requiredParam(params, "projectId"),
      storyboardId: requiredParam(params, "storyboardId"),
      sceneId: requiredParam(params, "sceneId"),
      beatId: requiredParam(params, "beatId"),
      panelId: requiredParam(params, "panelId"),
      data: parsePanelInput(body),
    });
    return { status: 200, body: { panel } };
  })
);

storyboardsRouter.delete(
  "/projects/:projectId/storyboards/:storyboardId/scenes/:sceneId/beats/:beatId/panels/:panelId",
  mutation(async ({ auth }, params) => {
    await deletePanel({
      auth,
      projectId: requiredParam(params, "projectId"),
      storyboardId: requiredParam(params, "storyboardId"),
      sceneId: requiredParam(params, "sceneId"),
      beatId: requiredParam(params, "beatId"),
      panelId: requiredParam(params, "panelId"),
    });
    return { status: 200, body: { ok: true } };
  })
);
