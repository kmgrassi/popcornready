export const TOOL_NAMES = [
  "create_or_load_brief",
  "develop_story_blueprint",
  "draft_script",
  "plan_shots",
  "plan_visual_anchors",
  "generate_anchor",
  "generate_storyboard",
  "generate_keyframe",
  "generate_clip",
  "generate_audio",
  "assemble_timeline",
  "critique_timeline",
  "request_approval",
  "export_video",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

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
      status: "waiting_for_approval";
      gateId: string;
      resumesWhen: "approval_terminal";
      previewArtifactIds: string[];
    }
  | {
      status: "failed";
      error: ToolError;
    };

export interface ToolDefinition {
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  requiredResourceIds: string[];
  mode: "sync" | "async" | "approval";
  estimateCostUsd(input: unknown): number | undefined;
  execute(input: unknown, context: ToolExecutionContext): Promise<ToolCallResult>;
}

export interface ToolExecutionContext {
  workspaceId: string;
  projectId: string;
  orchestratorRunId: string;
  actorId?: string;
  requestId?: string;
}

export interface ToolInvocation {
  id: string;
  orchestratorRunId: string;
  turnId: string;
  toolName: ToolName;
  input: unknown;
  status: ToolInvocationStatus;
  jobId?: string;
  gateId?: string;
  result?: ToolCallResult;
  error?: ToolError;
  createdAt: string;
  updatedAt: string;
}

export interface OrchestratorTurn {
  id: string;
  orchestratorRunId: string;
  inputSummary: string;
  model: string;
  toolCalls: ToolInvocation[];
  terminalReason: "tool_requested" | "waiting" | "done" | "error";
  createdAt: string;
}

export interface OrchestratorRun {
  id: string;
  projectId: string;
  generationRunId?: string;
  status: "running" | "waiting" | "succeeded" | "failed" | "cancelled";
  currentTurnId?: string;
  waitingOn?: {
    kind: "tool_job" | "approval_gate";
    id: string;
  };
  budget?: {
    maxUsd?: number;
    spentUsd: number;
    proposedUsd: number;
  };
  createdAt: string;
  updatedAt: string;
}

export type OrchestratorModelDecision =
  | {
      type: "tool_call";
      toolName: ToolName;
      input: Record<string, unknown>;
      model: string;
    }
  | {
      type: "done";
      summary: string;
      model: string;
    };
