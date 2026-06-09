// Generation progress emission interface (Generation Progress UI scope, PR3).
//
// This is the seam that the generation code paths call to publish run, stage,
// and stage-item progress as work moves through creative_plan, asset_generation,
// audio_generation, timeline_assembly, quality_review, and export. PR2 is
// responsible for the persisting implementation that backs these calls with the
// run/stage/stage-item store; until that lands, the default `noopProgressEmitter`
// keeps callers wired without changing observable behaviour.
//
// The emitter is intentionally scoped — a `RunProgressEmitter` is bound to a
// single run, a `RunStageHandle` to a single stage on that run, and a
// `RunStageItemHandle` to a single item on that stage. The orchestrator that
// owns the run constructs the emitter; the generation paths receive it (and
// the stage handles produced from it) through their dependency arguments.
//
// Run state continues to be derived from the underlying job state — this file
// does NOT define a new status vocabulary. See `GenerationRunStatus` in
// `./types`, which is an alias for `JobStatus`.

import {
  GenerationErrorSummary,
  GenerationStageItem,
  GenerationStageType,
} from "@popcorn/shared/v1/types";

// --- Public interfaces -----------------------------------------------------

export interface BeginStageOptions {
  label?: string;
  message?: string;
  // Position in the stage rail. Defaults to the type's natural order
  // (see `STAGE_ORDER` below) when omitted.
  order?: number;
}

export interface StageUpdate {
  progressPercent?: number;
  message?: string;
}

export interface StartStageItemOptions {
  kind: GenerationStageItem["kind"];
  label: string;
  provider?: string;
  // Short, redacted preview of the prompt for the UI. Callers should clip this
  // themselves; the emitter does not truncate.
  promptPreview?: string;
}

export interface StageSucceedOptions {
  message?: string;
  // Artifact id of the stage's persisted output (the plan, the assembled
  // timeline, …). Mirrors the item-level `assetId`/`artifactId`: the stage's
  // result is persisted as a first-class addressable artifact so an evaluator
  // can read it as evidence after the stage succeeds (Stage Eval Framework §3
  // "Evidence-bearing hook"). The emitter links it onto the stage.
  resultArtifactId?: string;
}

export interface StageItemSucceedOptions {
  // Asset produced by the item. Wired through so the run UI can resolve a
  // thumbnail/preview without a second round-trip.
  assetId?: string;
  // Artifact produced by the item (used by the export stage).
  artifactId?: string;
  message?: string;
}

export interface RunProgressEmitter {
  // Begin a new stage on the run. Implementations are expected to update the
  // run-level `currentStageType` to `type` and roll the previous stage (if any)
  // to its terminal state if the caller did not.
  beginStage(
    type: GenerationStageType,
    opts?: BeginStageOptions
  ): Promise<RunStageHandle>;

  // Update run-level fields directly. Useful for bumping `progressPercent` or
  // setting a top-line message between stage transitions.
  updateRun(patch: StageUpdate): Promise<void>;

  // Optional persisted-run review feedback helpers. Generation code reads this
  // before the stage that can consume it, then clears it once the model accepts
  // the feedback into a new output.
  getReviewFeedback?(): Promise<string | null>;
  clearReviewFeedback?(): Promise<void>;
}

export interface RunStageHandle {
  readonly type: GenerationStageType;

  // Update mid-stage. Implementations roll the patch into both the stage and
  // (where appropriate) the run-level summary.
  update(patch: StageUpdate): Promise<void>;

  // Start a sub-item on this stage (e.g. one image inside asset_generation).
  startItem(opts: StartStageItemOptions): Promise<RunStageItemHandle>;

  // Link a backend Job that participates in this stage. The run aggregates
  // status from these jobs.
  attachJob(jobId: string): Promise<void>;

  // Link an artifact produced by this stage so the UI can reach it.
  attachArtifact(artifactId: string): Promise<void>;

  // Terminal transitions. `succeed` and `cancel` move the stage to a clean
  // end-state; `fail` records a structured error summary that the UI can
  // surface alongside any retry/cancel affordances.
  succeed(opts?: StageSucceedOptions): Promise<void>;
  fail(error: GenerationErrorSummary): Promise<void>;
  cancel(opts?: { message?: string }): Promise<void>;
}

export interface RunStageItemHandle {
  // Stable identifier exposed for tests and logging. Implementations may
  // assign whatever id they use in persistence.
  readonly itemId: string;

  update(patch: StageUpdate): Promise<void>;
  succeed(opts?: StageItemSucceedOptions): Promise<void>;
  fail(error: GenerationErrorSummary): Promise<void>;
}

// Natural ordering used when callers do not pass an explicit `order`. Mirrors
// the stage list in the Generation Progress UI scope doc.
export const STAGE_ORDER: Record<GenerationStageType, number> = {
  brief_intake: 0,
  creative_plan: 1,
  storyboard: 2,
  asset_generation: 3,
  audio_generation: 4,
  timeline_assembly: 5,
  quality_review: 6,
  export: 7,
  ready: 8,
};

// --- No-op default ---------------------------------------------------------

// The default emitter is a fully-typed no-op so generation paths can wire
// progress calls today without breaking callers that do not yet construct a
// run. PR2 replaces this with a persisting implementation.

const noopItem: RunStageItemHandle = {
  itemId: "",
  async update() {},
  async succeed() {},
  async fail() {},
};

function noopStage(type: GenerationStageType): RunStageHandle {
  return {
    type,
    async update() {},
    async startItem() {
      return noopItem;
    },
    async attachJob() {},
    async attachArtifact() {},
    async succeed() {},
    async fail() {},
    async cancel() {},
  };
}

export const noopProgressEmitter: RunProgressEmitter = {
  async beginStage(type) {
    return noopStage(type);
  },
  async updateRun() {},
  async getReviewFeedback() {
    return null;
  },
  async clearReviewFeedback() {},
};

// --- Error mapping ---------------------------------------------------------

// Provider failures arrive as `Error`, `ApiError`, or arbitrary thrown values.
// The progress UI needs the same shape regardless, with a `retryable` flag the
// retry affordance keys off and a redacted, diagnostic-safe `details` string.

interface ErrorLike {
  code?: unknown;
  message?: unknown;
  retryable?: unknown;
  details?: unknown;
}

const RETRYABLE_CODES = new Set([
  "provider_timeout",
  "provider_unavailable",
  "provider_rate_limited",
  "provider_transient",
  "rate_limited",
  "timeout",
  "network_error",
]);

// Codes that are inherently NOT recoverable by replay: bad input, policy
// violations, missing prerequisites. Listing them keeps `toErrorSummary` from
// flagging structural failures as retryable just because the code is unknown.
const NON_RETRYABLE_CODES = new Set([
  "validation_failed",
  "brief_missing",
  "asset_invalid",
  "asset_not_ready",
  "not_found",
  "idempotency_conflict",
  "unsupported_format",
  "unsupported_duration_policy",
  "policy_violation",
  "model_output_invalid",
  "timeline_invalid",
]);

export interface ToErrorSummaryOptions {
  // Hard override for callers that know the failure is (or is not) safe to
  // replay (e.g. structural validation vs. a flaky provider call).
  retryable?: boolean;
  // Fallback code if the error carries none.
  fallbackCode?: string;
}

export function toErrorSummary(
  err: unknown,
  opts: ToErrorSummaryOptions = {}
): GenerationErrorSummary {
  const raw = (err && typeof err === "object" ? (err as ErrorLike) : {}) as ErrorLike;
  const code =
    typeof raw.code === "string" && raw.code.length > 0
      ? raw.code
      : opts.fallbackCode ?? "internal_error";
  const message =
    typeof raw.message === "string" && raw.message.length > 0
      ? raw.message
      : err instanceof Error
        ? err.message
        : "Generation step failed.";

  let retryable: boolean;
  if (typeof opts.retryable === "boolean") {
    retryable = opts.retryable;
  } else if (typeof raw.retryable === "boolean") {
    retryable = raw.retryable;
  } else if (NON_RETRYABLE_CODES.has(code)) {
    retryable = false;
  } else if (RETRYABLE_CODES.has(code)) {
    retryable = true;
  } else {
    // Default unknown failures to retryable=false so the UI does not invite
    // users to replay something that will deterministically fail again.
    retryable = false;
  }

  const summary: GenerationErrorSummary = { code, message, retryable };
  if (typeof raw.details === "string" && raw.details.length > 0) {
    summary.details = raw.details;
  }
  return summary;
}

// --- Convenience helpers ---------------------------------------------------

// Pick the right asset-producing stage for a given generative kind. Image and
// video flow through `asset_generation`; audio is its own stage so the UI can
// surface narration/music separately.
export function stageTypeForAssetKind(
  kind: "image" | "video" | "audio"
): GenerationStageType {
  return kind === "audio" ? "audio_generation" : "asset_generation";
}

export function stageItemKindForAssetKind(
  kind: "image" | "video" | "audio"
): GenerationStageItem["kind"] {
  return kind;
}
