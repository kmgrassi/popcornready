import type { Router } from "express";
import { assetsRouter } from "./assets.js";
import { briefRouter } from "./brief.js";
import { evalRouter } from "./eval.js";
import { generationEntrypointsRouter } from "./generation-entrypoints.js";
import { generationRunsRouter } from "./generation-runs.js";
import { generationsRouter } from "./generations.js";
import { meRouter } from "./me.js";
import { miscCapabilitiesRouter } from "./misc-capabilities.js";
import { planRouter } from "./plan.js";
import { projectsRouter } from "./projects.js";
import { timelinesRouter } from "./timelines.js";

export function mountProtectedV1Routes(v1: Router) {
  v1.use(meRouter);
  v1.use(projectsRouter);
  v1.use(assetsRouter);
  v1.use(briefRouter);
  v1.use(miscCapabilitiesRouter);
  v1.use(planRouter);
  v1.use(generationEntrypointsRouter);
  v1.use(generationRunsRouter);
  v1.use(timelinesRouter);
  v1.use(generationsRouter);
  v1.use(evalRouter);
}
