import { ApiError } from "@/core/errors";

export type ToolName =
  | "create_or_load_brief"
  | "develop_story_blueprint"
  | "draft_script"
  | "plan_shots"
  | "plan_visual_anchors"
  | "generate_anchor"
  | "generate_storyboard"
  | "generate_keyframe"
  | "generate_clip"
  | "generate_audio"
  | "assemble_timeline"
  | "critique_timeline"
  | "request_approval"
  | "export_video";

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
  tool: ToolName;
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

export interface ToolFailureContext {
  toolName: ToolName;
  input?: Record<string, unknown>;
  retryAfterSec?: number;
}

export interface ApprovalRejectedContext {
  stageType?: string;
  note?: string;
  previousTool?: ToolName;
  inputHint?: Record<string, unknown>;
}

export interface BudgetExceededContext {
  toolName: ToolName;
  estimatedCostUsd?: number;
  maxUsd?: number;
  spentUsd?: number;
  inputHint?: Record<string, unknown>;
}

const PROVIDER_QUOTA_PATTERNS = [
  "quota",
  "rate limit",
  "rate_limited",
  "rate-limited",
  "too many requests",
  "429",
  "insufficient_quota",
  "billing",
];

const POLICY_PATTERNS = [
  "policy",
  "safety",
  "moderation",
  "blocked",
  "not allowed",
];

const TIMEOUT_PATTERNS = [
  "timeout",
  "timed out",
  "did not complete within",
  "deadline",
  "polling deadline",
];

function compactRecord(
  value: Record<string, unknown>
): Record<string, unknown> | undefined {
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Tool invocation failed.";
}

function normalizedMessageIncludes(message: string, patterns: string[]): boolean {
  const lower = message.toLowerCase();
  return patterns.some((pattern) => lower.includes(pattern));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function firstString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function preconditionUnmet(args: {
  message: string;
  unmetRequirements: PreconditionMiss[];
  details?: Record<string, unknown>;
}): ToolError {
  return {
    kind: "precondition_unmet",
    message: args.message,
    recoverable: true,
    unmetRequirements: args.unmetRequirements,
    suggestedNextTools: args.unmetRequirements.map((miss) => miss.satisfyWith),
    details: args.details,
  };
}

export function providerQuotaError(args: {
  message: string;
  retryAfterSec?: number;
  fallbackTool?: SuggestedToolCall;
  details?: Record<string, unknown>;
}): ToolError {
  return {
    kind: "provider_quota",
    message: args.message,
    recoverable: true,
    retryAfterSec: args.retryAfterSec,
    suggestedNextTools: args.fallbackTool ? [args.fallbackTool] : undefined,
    details: args.details,
  };
}

export function budgetExceededError(args: BudgetExceededContext): ToolError {
  const details = compactRecord({
    estimatedCostUsd: args.estimatedCostUsd,
    maxUsd: args.maxUsd,
    spentUsd: args.spentUsd,
  });
  return {
    kind: "budget_exceeded",
    message: "The requested tool call would exceed the run budget.",
    recoverable: true,
    suggestedNextTools: [
      {
        tool: "request_approval",
        inputHint: {
          reason: "budget_exceeded",
          requestedTool: args.toolName,
          estimatedCostUsd: args.estimatedCostUsd,
          maxUsd: args.maxUsd,
          spentUsd: args.spentUsd,
          ...(args.inputHint || {}),
        },
      },
    ],
    details,
  };
}

export function approvalRejectedError(
  args: ApprovalRejectedContext = {}
): ToolError {
  const note = args.note?.trim();
  const recoveryTool = args.previousTool || toolForRejectedStage(args.stageType);
  return {
    kind: "approval_rejected",
    message: note
      ? `User rejected approval with note: ${note}`
      : "User rejected approval.",
    recoverable: true,
    suggestedNextTools: recoveryTool
      ? [
          {
            tool: recoveryTool,
            inputHint: {
              revisionInstruction: note || "Revise the rejected stage.",
              ...(args.inputHint || {}),
            },
          },
        ]
      : undefined,
    details: compactRecord({ stageType: args.stageType, note }),
  };
}

export function toolForRejectedStage(stageType?: string): ToolName | undefined {
  switch (stageType) {
    case "story":
    case "brief":
    case "blueprint":
      return "develop_story_blueprint";
    case "script":
      return "draft_script";
    case "plan":
    case "shots":
    case "beat_plan":
      return "plan_shots";
    case "anchors":
    case "visual_anchors":
      return "plan_visual_anchors";
    case "storyboard":
      return "generate_storyboard";
    case "keyframe":
    case "keyframes":
      return "generate_keyframe";
    case "clip":
    case "clips":
    case "media":
      return "generate_clip";
    case "audio":
    case "narration":
      return "generate_audio";
    case "timeline":
    case "assemble":
      return "assemble_timeline";
    default:
      return undefined;
  }
}

export function preconditionFromApiError(
  error: ApiError,
  context: ToolFailureContext
): ToolError | null {
  if (error.code === "brief_missing") {
    return preconditionUnmet({
      message: error.message,
      unmetRequirements: [
        {
          requirement: "brief_version",
          because: "The tool needs a persisted project brief before it can run.",
          satisfyWith: {
            tool: "create_or_load_brief",
            inputHint: { projectId: context.input?.projectId },
          },
        },
      ],
      details: { code: error.code },
    });
  }

  if (error.code === "asset_not_ready") {
    const assetIds = readStringArray(error.details?.assetIds);
    return preconditionUnmet({
      message: error.message,
      unmetRequirements: [
        {
          requirement: "ready_reference_asset",
          because: "The requested media tool depends on an asset that is not ready.",
          satisfyWith: {
            tool: chooseGenerationTool(context.toolName),
            inputHint: {
              projectId: context.input?.projectId,
              assetIds,
            },
          },
        },
      ],
      details: compactRecord({ code: error.code, assetIds }),
    });
  }

  if (error.code === "validation_failed" || error.code === "asset_invalid") {
    return {
      kind: "invalid_input",
      message: error.message,
      recoverable: true,
      suggestedNextTools: [
        {
          tool: context.toolName,
          inputHint: {
            reviseInput: true,
            fields: error.details?.fields,
          },
        },
      ],
      details: compactRecord({ code: error.code, ...error.details }),
    };
  }

  if (error.code === "rate_limited") {
    return providerQuotaError({
      message: error.message,
      retryAfterSec: context.retryAfterSec,
      details: { code: error.code },
    });
  }

  return null;
}

export function classifyToolFailure(
  error: unknown,
  context: ToolFailureContext
): ToolError {
  if (error instanceof ApiError) {
    const converted = preconditionFromApiError(error, context);
    if (converted) return converted;
  }

  const message = messageOf(error);
  if (normalizedMessageIncludes(message, PROVIDER_QUOTA_PATTERNS)) {
    return providerQuotaError({
      message,
      retryAfterSec: context.retryAfterSec,
    });
  }

  if (normalizedMessageIncludes(message, POLICY_PATTERNS)) {
    return {
      kind: "policy_violation",
      message,
      recoverable: true,
      suggestedNextTools: [
        {
          tool: context.toolName,
          inputHint: { reviseInputForPolicy: true },
        },
      ],
    };
  }

  if (normalizedMessageIncludes(message, TIMEOUT_PATTERNS)) {
    return {
      kind: "timeout",
      message,
      recoverable: true,
      retryAfterSec: context.retryAfterSec,
      suggestedNextTools: [
        {
          tool: context.toolName,
          inputHint: { retry: true },
        },
      ],
    };
  }

  return {
    kind: "provider_failed",
    message,
    recoverable: false,
  };
}

export function buildSelfHealTurnInput(args: {
  failedTool: ToolName;
  input?: Record<string, unknown>;
  error: ToolError;
}): Record<string, unknown> {
  return {
    failedTool: args.failedTool,
    failedInput: args.input || {},
    toolError: args.error,
    recoveryOptions: args.error.suggestedNextTools || [],
    instruction:
      "Choose a suggested recovery tool when it can satisfy the failure. Otherwise revise the failed tool input, request approval, or stop.",
  };
}

function chooseGenerationTool(failedTool: ToolName): ToolName {
  if (
    failedTool === "generate_clip" ||
    failedTool === "generate_keyframe" ||
    failedTool === "generate_audio" ||
    failedTool === "generate_anchor" ||
    failedTool === "generate_storyboard"
  ) {
    return failedTool;
  }
  return "generate_anchor";
}

export function parseToolError(value: unknown): ToolError | null {
  if (!isPlainObject(value)) return null;
  const kind = firstString(value.kind);
  const message = firstString(value.message);
  if (!kind || !message) return null;
  const recoverable =
    typeof value.recoverable === "boolean" ? value.recoverable : false;
  return {
    kind: kind as ToolErrorKind,
    message,
    recoverable,
    retryAfterSec:
      typeof value.retryAfterSec === "number" ? value.retryAfterSec : undefined,
    unmetRequirements: Array.isArray(value.unmetRequirements)
      ? (value.unmetRequirements as PreconditionMiss[])
      : undefined,
    suggestedNextTools: Array.isArray(value.suggestedNextTools)
      ? (value.suggestedNextTools as SuggestedToolCall[])
      : undefined,
    details: isPlainObject(value.details) ? value.details : undefined,
  };
}
