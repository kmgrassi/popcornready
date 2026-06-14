import { planEdit as realPlanEdit } from "@/lib/agent";
import type { VideoBrief } from "@/lib/api/v1/schemas";
import {
  addProjectPlan as realAddProjectPlan,
  getActiveProjectBrief as realGetActiveProjectBrief,
} from "@/lib/api/v1/store";
import { briefToStoryContext } from "@/lib/v1/generation/prepare";
import type { EditPlan } from "@popcorn/shared/types";
import type { VideoBriefInput } from "@popcorn/shared/v1/types";
import type { ToolCallResult, ToolDefinition } from "./types";
import { ToolInputError } from "./types";

// plan_shots derives the plan from the project's persisted brief (the stage→stage
// handoff through the asset graph) and persists the result as the active 'plan'
// asset. The model just decides *when* to plan; the brief is the source of truth.
export interface PlanShotsInput {
  /** Optional instruction to revise an existing plan. */
  feedback?: string;
}

export interface PlanShotsOutput {
  plan: EditPlan;
  planAssetId: string;
}

export interface PlanShotsDeps {
  planEdit: typeof realPlanEdit;
  getActiveProjectBrief: typeof realGetActiveProjectBrief;
  addProjectPlan: typeof realAddProjectPlan;
}

const defaultDeps: PlanShotsDeps = {
  planEdit: realPlanEdit,
  getActiveProjectBrief: realGetActiveProjectBrief,
  addProjectPlan: realAddProjectPlan,
};

const DEFAULT_STYLE = "fast-paced social ad";

const num = { type: "number" } as const;
const str = { type: "string" } as const;

const persistedBeatSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: str,
    name: str,
    durationSec: num,
    intent: str,
  },
  required: ["id", "name", "durationSec", "intent"],
};

const persistedSceneSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: str,
    name: str,
    setting: str,
    mood: str,
    characterIds: { type: "array", items: str },
    anchorAssetId: str,
    beats: { type: "array", items: persistedBeatSchema },
  },
  required: ["id", "name", "beats"],
};

export const persistedEditPlanSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    targetLengthSec: num,
    style: str,
    aspectRatio: { type: "string", enum: ["9:16", "16:9", "1:1"] },
    scenes: {
      type: "array",
      items: persistedSceneSchema,
    },
  },
  required: ["targetLengthSec", "style", "aspectRatio", "scenes"],
};

// The plan's creative inputs come from the brief, so the model supplies almost
// nothing here. Permissive on extra fields the model may pass out of habit; only
// `feedback` is read.
export const planShotsInputSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    feedback: {
      type: "string",
      description: "Optional instruction to revise an existing plan.",
    },
  },
  required: [],
};

export const planShotsOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    plan: persistedEditPlanSchema,
    planAssetId: str,
  },
  required: ["plan", "planAssetId"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePlanShotsInput(input: unknown): PlanShotsInput {
  if (input === undefined || input === null) return {};
  if (!isRecord(input)) {
    throw new ToolInputError("plan_shots input must be an object.", {
      expected: planShotsInputSchema,
    });
  }
  const feedback = input.feedback;
  if (feedback !== undefined && typeof feedback !== "string") {
    throw new ToolInputError("plan_shots feedback must be a string.", {});
  }
  return feedback && feedback.trim() ? { feedback: feedback.trim() } : {};
}

function briefRequired(): ToolCallResult<PlanShotsOutput> {
  return {
    status: "failed",
    error: {
      kind: "precondition_unmet",
      message: "plan_shots needs a project brief before it can plan shots.",
      recoverable: true,
      unmetRequirements: [
        {
          requirement: "brief",
          because:
            "The plan is derived from the project's brief (goal, length, aspect ratio, style).",
          satisfyWith: { tool: "create_or_load_brief", inputHint: {} },
        },
      ],
      suggestedNextTools: [{ tool: "create_or_load_brief", inputHint: {} }],
    },
  };
}

export function createPlanShotsTool(
  deps: Partial<PlanShotsDeps> = {}
): ToolDefinition<PlanShotsInput, PlanShotsOutput> {
  const resolved = { ...defaultDeps, ...deps };

  return {
    name: "plan_shots",
    description:
      "Plan ordered scenes and beats from the project's brief and persist them as the active plan. Requires a brief first.",
    inputSchema: planShotsInputSchema,
    outputSchema: planShotsOutputSchema,
    execution: "sync",
    parseInput: parsePlanShotsInput,
    estimateCost: () => ({
      estimatedCostUsd: 0,
      unit: "model_call",
      notes: "Planning is a cheap structured agent call and does not spend media budget.",
    }),
    async execute(input, context) {
      if (!context.projectId) {
        return {
          status: "failed",
          error: {
            kind: "precondition_unmet",
            message: "plan_shots requires a projectId in the execution context.",
            recoverable: false,
          },
        };
      }

      const active = await resolved.getActiveProjectBrief(context.projectId);
      if (!active) {
        return briefRequired();
      }
      const { brief } = active;

      const plan = await resolved.planEdit({
        goal: brief.goal,
        targetLengthSec: brief.targetLengthSec,
        style: brief.style ?? DEFAULT_STYLE,
        aspectRatio: brief.aspectRatio,
        storyContext: briefToStoryContext(brief as unknown as VideoBriefInput),
        feedback: input.feedback ?? null,
      });

      // Record the brief as the plan's input so a brief replacement marks the
      // plan (and its downstream) stale.
      const { planAssetId } = await resolved.addProjectPlan({
        workspaceId: context.auth.workspaceId,
        projectId: context.projectId,
        plan,
        briefAssetId: active.assetId,
        briefContentHash: active.contentHash,
      });

      return {
        status: "succeeded",
        resourceIds: [planAssetId],
        output: { plan, planAssetId },
      };
    },
  };
}
