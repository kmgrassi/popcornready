import { parseBrief, type VideoBrief } from "@/lib/api/v1/schemas";
import { addProjectBrief as realAddProjectBrief } from "@/lib/api/v1/store";
import type { ToolDefinition } from "./types";
import { ToolInputError } from "./types";

export interface CreateBriefOutput {
  briefVersionId: string;
  brief: VideoBrief;
}

export interface CreateBriefDeps {
  addProjectBrief: typeof realAddProjectBrief;
}

const defaultDeps: CreateBriefDeps = {
  addProjectBrief: realAddProjectBrief,
};

const str = { type: "string" } as const;

// Provider-neutral JSON schema the model fills. Kept deliberately close to the
// server-authoritative VideoBrief shape (apps/api/src/lib/api/v1/schemas.ts) so
// the model is steered toward fields the database actually accepts. parseInput
// is the real guard — this schema is the hint, parseBrief is the contract.
export const createBriefInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    goal: { type: "string", description: "What the video should accomplish." },
    targetLengthSec: {
      type: "number",
      description: "Target length in seconds. Must be between 1 and 600.",
    },
    aspectRatio: { type: "string", enum: ["9:16", "16:9", "1:1"] },
    platform: str,
    audience: str,
    style: str,
    format: str,
    hookQuestion: str,
    strongestVisual: str,
    oneBigIdea: str,
    caveat: str,
    payoff: str,
  },
  required: ["goal", "targetLengthSec", "aspectRatio"],
} as const;

export const createBriefOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    briefVersionId: { type: "string" },
    brief: { type: "object", additionalProperties: true },
  },
  required: ["briefVersionId", "brief"],
} as const;

// Reuse the server-authoritative brief validator. It throws an ApiError-style
// validation error; translate that into the recoverable ToolInputError envelope
// so the orchestrator can report it (and so out-of-schema agent input never
// reaches the INSERT).
export function parseCreateBriefInput(input: unknown): VideoBrief {
  try {
    return parseBrief(input, "brief");
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid brief input.";
    const details =
      err && typeof err === "object" && "details" in err
        ? (err as { details?: Record<string, unknown> }).details
        : undefined;
    throw new ToolInputError(message, details);
  }
}

export function createBriefTool(
  deps: Partial<CreateBriefDeps> = {}
): ToolDefinition<VideoBrief, CreateBriefOutput> {
  const resolved = { ...defaultDeps, ...deps };

  return {
    name: "create_or_load_brief",
    description:
      "Create the project's video brief from the user's prompt: structured goal, target length, aspect ratio, and optional platform/audience/style. Persists the brief as the project's active brief.",
    inputSchema: createBriefInputSchema,
    outputSchema: createBriefOutputSchema,
    execution: "sync",
    parseInput: parseCreateBriefInput,
    estimateCost: () => ({
      estimatedCostUsd: 0,
      unit: "db_write",
      notes: "Persisting a brief is a structured DB write and spends no media budget.",
    }),
    async execute(brief, context) {
      if (!context.projectId) {
        return {
          status: "failed",
          error: {
            kind: "precondition_unmet",
            message: "create_or_load_brief requires a projectId in the execution context.",
            recoverable: false,
          },
        };
      }
      const briefVersion = await resolved.addProjectBrief({
        workspaceId: context.auth.workspaceId,
        projectId: context.projectId,
        brief,
      });
      return {
        status: "succeeded",
        resourceIds: [briefVersion.id],
        output: { briefVersionId: briefVersion.id, brief },
      };
    },
  };
}
