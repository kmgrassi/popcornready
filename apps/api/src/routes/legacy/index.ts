import type { Express } from "express";

// Legacy (non-v1) endpoints used by the current UI: /api/project, /api/upload,
// /api/generate, /api/revise, /api/export, /api/oneshot, /api/compositions, etc.
// These are ported behind explicit compatibility routers and decommissioned as
// the web app migrates to v1 (see MIGRATION.md for the parity matrix).
export function mountLegacy(_app: Express) {
  // TODO(migration): mount ported legacy routers here.
}
