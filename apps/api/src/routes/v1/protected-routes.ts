import type { Router } from "express";
import { briefRouter } from "./brief.js";
import { meRouter } from "./me.js";
import { projectsRouter } from "./projects.js";

export function mountProtectedV1Routes(v1: Router) {
  v1.use(meRouter);
  v1.use(projectsRouter);
  v1.use(briefRouter);
}
