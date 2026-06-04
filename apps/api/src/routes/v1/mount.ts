import type { Express } from "express";
import { Router } from "express";
import { authMiddleware } from "../../middleware/auth.js";
import { mountProtectedV1Routes } from "./protected-routes.js";
import { mountPublicV1Routes } from "./public-routes.js";

// Mounts the versioned agent API under /api/v1. Route groups live in focused
// files so parallel route work does not converge on one aggregator.
export function mountV1(app: Express) {
  const v1 = Router();

  // Public routes mount before authMiddleware; they do not require a session.
  mountPublicV1Routes(v1);

  // Everything after this line requires an authenticated caller. In supabase mode
  // authMiddleware verifies the session, builds the user-scoped RLS client, and
  // resolves public.users.id into the request context. In AUTH_MODE=local it is a
  // pass-through (resolveAuth supplies the deterministic dev identity).
  v1.use(authMiddleware);

  mountProtectedV1Routes(v1);

  app.use("/api/v1", v1);
}
