import type { Express } from "express";
import { Router } from "express";
import { healthRouter } from "./health.js";
import { meRouter } from "./me.js";
import { projectsRouter } from "./projects.js";

// Mounts the versioned agent API under /api/v1. Route groups are added here as
// each is ported from the former Next.js handlers (see MIGRATION.md for the
// parity matrix).
export function mountV1(app: Express) {
  const v1 = Router();

  // One line per route group: parallel A-track PRs add their router here.
  v1.use(healthRouter);
  v1.use(meRouter);
  v1.use(projectsRouter);

  app.use("/api/v1", v1);
}
