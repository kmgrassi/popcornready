import type { Router } from "express";
import { healthRouter } from "./health.js";

export function mountPublicV1Routes(v1: Router) {
  v1.use(healthRouter);
}
