// Status helpers and the composite response shape used by PR #8 (retry,
// cancel, recovery). The shared GenerationRun/Stage/StageItem types live in
// src/lib/v1/types.ts and are owned by PR #1; this file adds the small
// active/terminal predicates the progress UI needs without expanding that
// contract.
//
// GenerationRunDetail is the response shape the polling endpoint
// (GET /api/v1/projects/:projectId/generation-runs/:runId) returns. The
// endpoint itself is PR #4; defining the shape here lets PR #8's client and
// hooks type their results today.

import {
  GenerationRun,
  GenerationRunStatus,
  GenerationStage,
  GenerationStageItem,
} from "../types";

export const ACTIVE_RUN_STATUSES: ReadonlySet<GenerationRunStatus> = new Set([
  "queued",
  "running",
]);

export const TERMINAL_RUN_STATUSES: ReadonlySet<GenerationRunStatus> = new Set([
  "succeeded",
  "failed",
  "canceled",
]);

export function isRunActive(status: GenerationRunStatus): boolean {
  return ACTIVE_RUN_STATUSES.has(status);
}

export function isRunTerminal(status: GenerationRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

export interface GenerationRunDetail {
  run: GenerationRun;
  stages: GenerationStage[];
  stageItems: GenerationStageItem[];
}
