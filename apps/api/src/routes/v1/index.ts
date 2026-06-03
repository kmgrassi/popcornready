import type { Express } from "express";
import { Router } from "express";
import { healthRouter } from "./health.js";

// Mounts the versioned agent API under /api/v1. Route groups are added here as
// each is ported from the former Next.js handlers (see MIGRATION.md for the
// parity matrix).
export function mountV1(app: Express) {
  const v1 = Router();

  v1.use(healthRouter);
  // TODO(migration): mount me, projects, assets, generations, generation-runs,
  // brief, timelines, exports, generated-assets, artifacts routers here.

  app.use("/api/v1", v1);
}
