import { Router } from "express";

export const healthRouter = Router();

// GET /api/v1/health — liveness probe used by Railway's healthcheck.
healthRouter.get("/health", (req, res) => {
  const authMode = (process.env.AUTH_MODE || "local") === "local" ? "local" : "supabase";
  res.status(200).json({
    status: "ok",
    authMode,
    time: new Date().toISOString(),
  });
});
