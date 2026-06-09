import {
  client as anthropicClient,
  MODEL,
  structuredCall,
  structuredVisionCall,
} from "../anthropic";
import {
  ChooseToolArgs,
  LlmClient,
  LlmEffort,
  StructuredArgs,
  StructuredVisionArgs,
  ToolChoiceResult,
  ToolSpec,
} from "./types";

// Anthropic output_config.effort is low|medium|high|max — there is no
// "minimal", so map it to "low".
function toAnthropicEffort(
  effort?: LlmEffort
): "low" | "medium" | "high" | undefined {
  if (!effort) return undefined;
  return effort === "minimal" ? "low" : effort;
}

type MessageCreate = (params: Record<string, unknown>) => Promise<any>;

// Low-reasoning calls route to the cheaper fast model.
const FAST_EFFORTS = new Set<LlmEffort>(["minimal", "low"]);

export interface AnthropicDeps {
  model?: string;
  // Cheaper model for minimal/low-effort calls. Defaults to `model`.
  fastModel?: string;
  // Injected in tests; defaults to the real Anthropic client lazily.
  createMessage?: MessageCreate;
}

export function toAnthropicTool(spec: ToolSpec): Record<string, unknown> {
  return {
    name: spec.name,
    description: spec.description,
    input_schema: spec.parameters,
  };
}

// Pure response parsing — unit-tested without a network call.
export function interpretAnthropicToolResponse(
  res: any,
  fallbackModel: string,
  allowed?: Set<string>
): ToolChoiceResult {
  const content = Array.isArray(res?.content) ? res.content : [];
  const toolUses = content.filter((block: any) => block?.type === "tool_use");
  const model = res?.model ?? fallbackModel;

  if (toolUses.length > 1) {
    throw new Error("Orchestrator model returned more than one tool call.");
  }
  if (toolUses.length === 1) {
    const toolUse = toolUses[0];
    const name = String(toolUse?.name ?? "");
    if (allowed && !allowed.has(name)) {
      throw new Error(`Model requested an unknown tool: ${name}`);
    }
    const input =
      toolUse?.input && typeof toolUse.input === "object" && !Array.isArray(toolUse.input)
        ? (toolUse.input as Record<string, unknown>)
        : {};
    return { type: "tool_call", toolName: name, input, model };
  }

  const text = content
    .filter((block: any) => block?.type === "text")
    .map((block: any) => String(block.text || ""))
    .join("")
    .trim();
  return { type: "done", text: text || "No tool call requested.", model };
}

export function createAnthropicLlmClient(deps: AnthropicDeps = {}): LlmClient {
  const model = deps.model ?? MODEL;
  const fastModel = deps.fastModel ?? model;
  const pickModel = (effort?: LlmEffort): string =>
    effort && FAST_EFFORTS.has(effort) ? fastModel : model;
  let createMessage = deps.createMessage;
  const ensureCreate = (): MessageCreate => {
    if (createMessage) return createMessage;
    createMessage = ((params: Record<string, unknown>) =>
      anthropicClient().messages.create(params as any)) as MessageCreate;
    return createMessage;
  };

  return {
    provider: "anthropic",
    model,
    structured<T>(args: StructuredArgs) {
      return structuredCall<T>({
        ...args,
        model: pickModel(args.effort),
        effort: toAnthropicEffort(args.effort),
      });
    },
    structuredVision<T>(args: StructuredVisionArgs) {
      return structuredVisionCall<T>({
        ...args,
        model: pickModel(args.effort),
        effort: toAnthropicEffort(args.effort),
      });
    },
    async chooseTool(args: ChooseToolArgs) {
      const allowed = new Set(args.tools.map((tool) => tool.name));
      const callModel = pickModel(args.effort);
      const res = await ensureCreate()({
        model: callModel,
        max_tokens: args.maxTokens ?? 2000,
        system: args.system,
        tools: args.tools.map(toAnthropicTool),
        tool_choice: { type: "auto" },
        messages: [
          { role: "user", content: JSON.stringify(args.userPayload) },
        ],
      });
      return interpretAnthropicToolResponse(res, callModel, allowed);
    },
  };
}
