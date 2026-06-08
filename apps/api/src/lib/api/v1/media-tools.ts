import { AuthContext } from "./auth";
import { ApiError, validationError } from "./errors";
import { generateBeatClip, getBeatMediaJob } from "./beats";
import { V1Job } from "./jobs";

export type MediaToolName = "generate_clip";

export type ToolErrorKind =
  | "precondition_unmet"
  | "invalid_input"
  | "provider_quota"
  | "provider_failed"
  | "budget_exceeded"
  | "approval_rejected"
  | "policy_violation"
  | "timeout";

export interface SuggestedToolCall {
  tool: MediaToolName;
  inputHint: Record<string, unknown>;
}

export interface PreconditionMiss {
  requirement: string;
  because: string;
  satisfyWith: SuggestedToolCall;
}

export interface ToolError {
  kind: ToolErrorKind;
  message: string;
  recoverable: boolean;
  retryAfterSec?: number;
  unmetRequirements?: PreconditionMiss[];
  suggestedNextTools?: SuggestedToolCall[];
  details?: Record<string, unknown>;
}

export type ToolCallResult =
  | {
      status: "succeeded";
      resourceIds: string[];
      artifactIds?: string[];
      costUsd?: number;
      output?: unknown;
    }
  | {
      status: "accepted";
      jobId: string;
      resumesWhen: "job_terminal";
      estimatedCostUsd?: number;
    }
  | {
      status: "failed";
      error: ToolError;
    };

export interface GenerateClipToolInput {
  beatId: string;
  prompt?: string;
  compositionId?: string;
  anchorIds?: string[];
  autocreate?: boolean;
  provider?: string;
  model?: string;
  durationSec?: number;
  seconds?: number;
  referenceAssetIds?: string[];
  characterProfileIds?: string[];
  characterReferenceIds?: string[];
  consistencyMode?: unknown;
  preflightReviewIterations?: number;
  [key: string]: unknown;
}

export interface MediaToolDefinition {
  name: MediaToolName;
  mode: "async";
  startsJobType: "asset_generation";
}

export const generateClipTool: MediaToolDefinition = {
  name: "generate_clip",
  mode: "async",
  startsJobType: "asset_generation",
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseGenerateClipInput(input: unknown): GenerateClipToolInput {
  if (!isPlainObject(input)) {
    throw validationError("generate_clip input is invalid.", [
      { path: "", message: "Must be an object." },
    ]);
  }
  const beatId = String(input.beatId || "").trim();
  if (!beatId) {
    throw validationError("generate_clip input is invalid.", [
      { path: "beatId", message: "beatId is required." },
    ]);
  }
  return { ...input, beatId };
}

function assetIdsOf(job: V1Job): string[] {
  const result = job.result as { assetIds?: unknown } | null | undefined;
  return Array.isArray(result?.assetIds) ? result.assetIds.map(String) : [];
}

function toolErrorKindForCode(code: string | undefined): ToolErrorKind {
  if (code === "rate_limited") return "provider_quota";
  if (code === "validation_failed" || code === "asset_invalid") return "invalid_input";
  if (code === "asset_not_ready" || code === "brief_missing") {
    return "precondition_unmet";
  }
  if (code === "forbidden" || code === "unauthorized") return "policy_violation";
  if (code === "render_failed" || code === "job_failed" || code === "internal_error") {
    return "provider_failed";
  }
  return "provider_failed";
}

function toolErrorFromApiError(error: ApiError): ToolError {
  const kind = toolErrorKindForCode(error.code);
  return {
    kind,
    message: error.message,
    recoverable: kind !== "invalid_input" && kind !== "policy_violation",
    ...(error.code === "rate_limited" ? { retryAfterSec: 60 } : {}),
    ...(error.details ? { details: error.details } : {}),
  };
}

function toolErrorFromJob(job: V1Job): ToolError {
  const code = job.error?.code;
  const kind = toolErrorKindForCode(code);
  return {
    kind,
    message: job.error?.message || "generate_clip job failed.",
    recoverable: kind !== "invalid_input" && kind !== "policy_violation",
    ...(code === "rate_limited" ? { retryAfterSec: 60 } : {}),
    details: {
      jobId: job.id,
      ...(code ? { code } : {}),
    },
  };
}

export async function startGenerateClipTool(args: {
  auth: AuthContext;
  projectId: string;
  input: unknown;
}): Promise<ToolCallResult> {
  try {
    const input = parseGenerateClipInput(args.input);
    const { beatId, ...body } = input;
    const result = await generateBeatClip({
      auth: args.auth,
      projectId: args.projectId,
      beatId,
      body,
    });
    const job = result.body.job as V1Job | undefined;
    if (!job?.id) {
      return {
        status: "failed",
        error: {
          kind: "provider_failed",
          message: "generate_clip did not return a pollable job.",
          recoverable: true,
        },
      };
    }
    return {
      status: "accepted",
      jobId: job.id,
      resumesWhen: "job_terminal",
    };
  } catch (err) {
    if (err instanceof ApiError) {
      return { status: "failed", error: toolErrorFromApiError(err) };
    }
    return {
      status: "failed",
      error: {
        kind: "provider_failed",
        message: err instanceof Error ? err.message : "generate_clip failed.",
        recoverable: true,
      },
    };
  }
}

export async function resumeGenerateClipTool(args: {
  auth: AuthContext;
  projectId: string;
  jobId: string;
}): Promise<ToolCallResult> {
  const result = await getBeatMediaJob(args);
  const job = result.body.job as V1Job;

  if (job.status === "succeeded") {
    const resourceIds = assetIdsOf(job);
    return {
      status: "succeeded",
      resourceIds,
      artifactIds: resourceIds,
      output: { jobId: job.id, assetIds: resourceIds },
    };
  }

  if (job.status === "failed" || job.status === "canceled") {
    return { status: "failed", error: toolErrorFromJob(job) };
  }

  return {
    status: "accepted",
    jobId: job.id,
    resumesWhen: "job_terminal",
  };
}
