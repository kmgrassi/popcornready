import { Router } from "express";
import { authMode } from "@/lib/api/v1/auth";

export const healthRouter = Router();

// GET /api/v1/health — liveness probe used by Railway's healthcheck.
healthRouter.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    authMode: authMode(),
    time: new Date().toISOString(),
  });
});
