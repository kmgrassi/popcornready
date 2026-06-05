import type { Router } from "express";
import { discoverRouter } from "./discover.js";
import { healthRouter } from "./health.js";

export function mountPublicV1Routes(v1: Router) {
  v1.use(healthRouter);
  v1.use(discoverRouter);
}
