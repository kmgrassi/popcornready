import type { Express } from "express";
import { Router } from "express";
import { authMiddleware } from "../../middleware/auth.js";
import { assetsRouter } from "./assets.js";
import { briefRouter } from "./brief.js";
import { healthRouter } from "./health.js";
import { meRouter } from "./me.js";
import { projectsRouter } from "./projects.js";
import { generationEntrypointsRouter } from "./generation-entrypoints.js";

// Mounts the versioned agent API under /api/v1. Route groups are added here as
// each is ported from the former Next.js handlers (see MIGRATION.md for the
// parity matrix).
export function mountV1(app: Express) {
  const v1 = Router();

  // Public routes mount BEFORE authMiddleware (no session required).
  v1.use(healthRouter);

  // Everything after this line requires an authenticated caller. In supabase mode
  // authMiddleware verifies the session, builds the user-scoped RLS client, and
  // resolves public.users.id into the request context. In AUTH_MODE=local it is a
  // pass-through (resolveAuth supplies the deterministic dev identity).
  v1.use(authMiddleware);

  // One line per protected route group: parallel A-track PRs add their router here.
  v1.use(meRouter);
  v1.use(projectsRouter);
  v1.use(assetsRouter);
  v1.use(briefRouter);
  v1.use(generationEntrypointsRouter);

  app.use("/api/v1", v1);
}
