import {
  ToolCallResult,
  ToolDefinition,
  ToolExecutionContext,
  ToolName,
  TOOL_NAMES,
} from "./types";

export type ToolRegistry = Map<ToolName, ToolDefinition>;

const baseObjectSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    projectId: {
      type: "string",
      description: "Project id the tool should operate on.",
    },
    revisionInstruction: {
      type: "string",
      description: "Optional instruction when retrying or revising a stage.",
    },
  },
} as const;

function failedUnimplemented(toolName: ToolName): ToolCallResult {
  return {
    status: "failed",
    error: {
      kind: "precondition_unmet",
      message: `${toolName} is declared for the orchestrator vocabulary but is not wired to a live handler yet.`,
      recoverable: true,
      details: { toolName },
    },
  };
}

function defaultDefinition(name: ToolName): ToolDefinition {
  return {
    name,
    description: toolDescription(name),
    inputSchema: baseObjectSchema,
    outputSchema: {
      type: "object",
      additionalProperties: true,
    },
    requiredResourceIds: ["projectId"],
    mode: name === "request_approval" ? "approval" : mediaToolNames.has(name) ? "async" : "sync",
    estimateCostUsd: () => undefined,
    execute: async () => failedUnimplemented(name),
  };
}

const mediaToolNames = new Set<ToolName>([
  "generate_anchor",
  "generate_storyboard",
  "generate_keyframe",
  "generate_clip",
  "generate_audio",
  "export_video",
]);

function toolDescription(name: ToolName): string {
  switch (name) {
    case "create_or_load_brief":
      return "Create a new video brief from the prompt or load the active brief.";
    case "develop_story_blueprint":
      return "Develop a structured story blueprint for the project.";
    case "draft_script":
      return "Draft narration, dialogue, and scene copy from the story blueprint.";
    case "plan_shots":
      return "Plan scenes and beats with stable ids from the brief or script.";
    case "plan_visual_anchors":
      return "Identify recurring characters, locations, props, and required visual anchors.";
    case "generate_anchor":
      return "Generate a reusable visual anchor asset for a character, location, or prop.";
    case "generate_storyboard":
      return "Generate storyboard or previsualization assets for planned beats.";
    case "generate_keyframe":
      return "Generate a keyframe image for a beat.";
    case "generate_clip":
      return "Generate a motion clip for a beat.";
    case "generate_audio":
      return "Generate narration, dialogue, music, or sound assets.";
    case "assemble_timeline":
      return "Assemble available assets into a deterministic timeline.";
    case "critique_timeline":
      return "Review the assembled timeline and identify targeted fixes.";
    case "request_approval":
      return "Create a user approval gate before an expensive or user-visible stage.";
    case "export_video":
      return "Export the current approved timeline to a video artifact.";
  }
}

export function createToolRegistry(
  overrides: Partial<Record<ToolName, Partial<ToolDefinition>>> = {}
): ToolRegistry {
  return new Map(
    TOOL_NAMES.map((name) => {
      const base = defaultDefinition(name);
      const override = overrides[name] ?? {};
      return [name, { ...base, ...override } satisfies ToolDefinition];
    })
  );
}

export async function executeRegisteredTool(args: {
  registry: ToolRegistry;
  toolName: ToolName;
  input: unknown;
  context: ToolExecutionContext;
}): Promise<ToolCallResult> {
  const tool = args.registry.get(args.toolName);
  if (!tool) {
    return {
      status: "failed",
      error: {
        kind: "invalid_input",
        message: `Unknown orchestrator tool: ${args.toolName}`,
        recoverable: false,
        details: { toolName: args.toolName },
      },
    };
  }
  return tool.execute(args.input, args.context);
}
