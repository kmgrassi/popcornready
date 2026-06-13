import type { Router } from "express";
import { devToolTestsRouter, isToolTestHarnessEnabled } from "./dev-tool-tests.js";
import { discoverRouter } from "./discover.js";
import { healthRouter } from "./health.js";

export function mountPublicV1Routes(v1: Router) {
  v1.use(healthRouter);
  v1.use(discoverRouter);

  // Dev-only, flag-gated tool-call test harness. Never mounted in production.
  if (isToolTestHarnessEnabled()) {
    v1.use(devToolTestsRouter);
  }
}
