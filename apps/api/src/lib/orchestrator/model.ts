import { getLlmClient } from "../llm";
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

const SYSTEM_PROMPT =
  "You are the Popcorn Ready video-generation orchestrator. Decide the next single server-owned tool to call. The server owns validation, persistence, jobs, authorization, provider execution, and stage state. Call at most one tool.";

function requireToolName(value: unknown): ToolName {
  if (typeof value === "string" && TOOL_NAME_SET.has(value)) {
    return value as ToolName;
  }
  throw new Error(`Model requested an unknown tool: ${String(value)}`);
}

// One orchestrator turn: the configured LLM (OpenAI by default, Anthropic when
// LLM_PROVIDER=anthropic) picks the next single tool, or finishes with a
// summary. Tool definitions are passed provider-neutral; each adapter maps them
// to that provider's function-/tool-calling shape.
export const orchestratorModel: OrchestratorModel = async ({
  projectId,
  inputSummary,
  priorResults = [],
  registry,
  // Headroom so reasoning models (e.g. gpt-5) have budget left for the tool call
  // after thinking; non-reasoning models only use what they need.
  maxTokens = 4000,
}) => {
  const tools = [...registry.values()].map((tool: ToolDefinition) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  }));

  const decision = await getLlmClient().chooseTool({
    system: SYSTEM_PROMPT,
    userPayload: {
      projectId,
      inputSummary,
      priorResults,
      instruction:
        "Choose exactly one next tool if work remains. If all work is complete, answer with a concise text summary and no tool call.",
    },
    tools,
    maxTokens,
    effort: "medium", // pick the next single tool — modest reasoning
  });

  if (decision.type === "tool_call") {
    return {
      type: "tool_call",
      toolName: requireToolName(decision.toolName),
      input: decision.input,
      model: decision.model,
    };
  }

  return {
    type: "done",
    summary: decision.text || "No tool call requested.",
    model: decision.model,
  };
};
