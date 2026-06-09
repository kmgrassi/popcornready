import { planEdit as realPlanEdit } from "@/lib/agent";
import type { EditPlan, StoryContext } from "@popcorn/shared/types";
import type { ToolDefinition } from "./types";
import { ToolInputError } from "./types";

export interface PlanShotsInput {
  goal: string;
  targetLengthSec: number;
  style: string;
  aspectRatio: EditPlan["aspectRatio"];
  storyContext?: StoryContext | null;
}

export interface PlanShotsOutput {
  plan: EditPlan;
}

export interface PlanShotsDeps {
  planEdit: typeof realPlanEdit;
}

const defaultDeps: PlanShotsDeps = {
  planEdit: realPlanEdit,
};

const ASPECT_RATIOS = new Set(["9:16", "16:9", "1:1"]);
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

export const planShotsInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    goal: { type: "string", minLength: 1 },
    targetLengthSec: { type: "number", minimum: 1, maximum: 600 },
    style: { type: "string", minLength: 1 },
    aspectRatio: { type: "string", enum: ["9:16", "16:9", "1:1"] },
    storyContext: { type: ["object", "null"] },
  },
  required: ["goal", "targetLengthSec", "style", "aspectRatio"],
};

export const planShotsOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    plan: persistedEditPlanSchema,
  },
  required: ["plan"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRequiredString(
  input: Record<string, unknown>,
  key: string,
  errors: string[]
): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${key} must be a non-empty string.`);
    return "";
  }
  return value.trim();
}

export function parsePlanShotsInput(input: unknown): PlanShotsInput {
  const errors: string[] = [];
  if (!isRecord(input)) {
    throw new ToolInputError("plan_shots input must be an object.", {
      expected: planShotsInputSchema,
    });
  }

  const goal = parseRequiredString(input, "goal", errors);
  const style = parseRequiredString(input, "style", errors);
  const targetLengthSec = input.targetLengthSec;
  if (
    typeof targetLengthSec !== "number" ||
    !Number.isFinite(targetLengthSec) ||
    targetLengthSec < 1 ||
    targetLengthSec > 600
  ) {
    errors.push("targetLengthSec must be a number between 1 and 600.");
  }

  const aspectRatio = input.aspectRatio;
  if (typeof aspectRatio !== "string" || !ASPECT_RATIOS.has(aspectRatio)) {
    errors.push("aspectRatio must be one of: 9:16, 16:9, 1:1.");
  }

  const storyContext = input.storyContext;
  if (
    storyContext !== undefined &&
    storyContext !== null &&
    !isRecord(storyContext)
  ) {
    errors.push("storyContext must be an object or null.");
  }

  if (errors.length > 0) {
    throw new ToolInputError("Invalid plan_shots input.", { fields: errors });
  }

  return {
    goal,
    style,
    targetLengthSec: targetLengthSec as number,
    aspectRatio: aspectRatio as EditPlan["aspectRatio"],
    storyContext: (storyContext ?? null) as StoryContext | null,
  };
}

export function createPlanShotsTool(
  deps: Partial<PlanShotsDeps> = {}
): ToolDefinition<PlanShotsInput, PlanShotsOutput> {
  const resolvedDeps = { ...defaultDeps, ...deps };

  return {
    name: "plan_shots",
    description:
      "Convert a creative goal into ordered scenes and beats before media generation.",
    inputSchema: planShotsInputSchema,
    outputSchema: planShotsOutputSchema,
    execution: "sync",
    parseInput: parsePlanShotsInput,
    estimateCost: () => ({
      estimatedCostUsd: 0,
      unit: "model_call",
      notes: "Planning is a cheap structured agent call and does not spend media budget.",
    }),
    async execute(input) {
      const plan = await resolvedDeps.planEdit(input);
      return {
        status: "succeeded",
        resourceIds: [],
        output: { plan },
      };
    },
  };
}
