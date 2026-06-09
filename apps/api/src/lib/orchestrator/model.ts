import { client, MODEL } from "../anthropic";
import { ToolRegistry } from "./registry";
import {
  OrchestratorModelDecision,
  ToolDefinition,
  ToolName,
  TOOL_NAMES,
} from "./types";

const TOOL_NAME_SET = new Set<string>(TOOL_NAMES);

export interface ModelTurnInput {
  projectId: string;
  inputSummary: string;
  priorResults?: unknown[];
  registry: ToolRegistry;
  maxTokens?: number;
}

export type OrchestratorModel = (
  input: ModelTurnInput
) => Promise<OrchestratorModelDecision>;

function toAnthropicTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  };
}

function requireToolName(value: unknown): ToolName {
  if (typeof value === "string" && TOOL_NAME_SET.has(value)) {
    return value as ToolName;
  }
  throw new Error(`Model requested an unknown tool: ${String(value)}`);
}

export const anthropicOrchestratorModel: OrchestratorModel = async ({
  projectId,
  inputSummary,
  priorResults = [],
  registry,
  maxTokens = 2000,
}) => {
  const tools = [...registry.values()].map(toAnthropicTool);
  const res: any = await client().messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system:
      "You are the Popcorn Ready video-generation orchestrator. Decide the next single server-owned tool to call. The server owns validation, persistence, jobs, authorization, provider execution, and stage state. Call at most one tool.",
    tools,
    tool_choice: { type: "auto" },
    messages: [
      {
        role: "user",
        content: JSON.stringify({
          projectId,
          inputSummary,
          priorResults,
          instruction:
            "Choose exactly one next tool if work remains. If all work is complete, answer with a concise text summary and no tool call.",
        }),
      },
    ],
  } as any);

  const content = Array.isArray(res.content) ? res.content : [];
  const toolUses = content.filter((block: any) => block?.type === "tool_use");
  if (toolUses.length > 1) {
    throw new Error("Orchestrator model returned more than one tool call.");
  }
  if (toolUses.length === 1) {
    const toolUse = toolUses[0];
    return {
      type: "tool_call",
      toolName: requireToolName(toolUse.name),
      input:
        typeof toolUse.input === "object" && toolUse.input !== null
          ? toolUse.input
          : {},
      model: res.model ?? MODEL,
    };
  }

  const summary =
    content
      .filter((block: any) => block?.type === "text")
      .map((block: any) => String(block.text || ""))
      .join("")
      .trim() || "No tool call requested.";
  return { type: "done", summary, model: res.model ?? MODEL };
};
