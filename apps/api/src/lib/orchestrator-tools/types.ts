import type { AuthContext } from "@/lib/api/v1/auth";

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

export type ToolInvocationStatus =
  | "requested"
  | "running"
  | "waiting_for_job"
  | "waiting_for_approval"
  | "succeeded"
  | "failed"
  | "cancelled";

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

export type ToolCallResult<TOutput = unknown> =
  | {
      status: "succeeded";
      resourceIds: string[];
      artifactIds?: string[];
      costUsd?: number;
      output?: TOutput;
    }
  | {
      status: "accepted";
      jobId: string;
      resumesWhen: "job_terminal";
      estimatedCostUsd?: number;
    }
  | {
      status: "waiting_for_approval";
      gateId: string;
      resumesWhen: "approval_terminal";
      previewArtifactIds: string[];
    }
  | {
      status: "failed";
      error: ToolError;
    };

export type JsonSchema = Record<string, unknown>;

export interface ToolExecutionContext {
  auth: AuthContext;
  projectId?: string;
  generationRunId?: string;
  /** The orchestrator run driving this call — async tools' workers use it to
   * resume the run when their job completes. */
  orchestratorRunId?: string;
}

export interface ToolCostEstimate {
  estimatedCostUsd?: number;
  unit?: string;
  notes?: string;
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: ToolName;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  execution: "sync" | "async" | "approval";
  parseInput(input: unknown): TInput;
  estimateCost?(
    input: TInput,
    context: ToolExecutionContext
  ): ToolCostEstimate | Promise<ToolCostEstimate>;
  execute(
    input: TInput,
    context: ToolExecutionContext
  ): ToolCallResult<TOutput> | Promise<ToolCallResult<TOutput>>;
}

export class ToolInputError extends Error {
  readonly toolError: ToolError;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ToolInputError";
    this.toolError = {
      kind: "invalid_input",
      message,
      recoverable: true,
      details,
    };
  }
}
