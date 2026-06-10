import Anthropic from "@anthropic-ai/sdk";

import {
  ChooseToolArgs,
  LlmClient,
  LlmEffort,
  StructuredArgs,
  StructuredVisionArgs,
  ToolChoiceResult,
  ToolSpec,
} from "./types";

export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-4-7";

let _client: Anthropic | null = null;
export function anthropicClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Copy .env.local.example to .env.local and add your key."
    );
  }
  if (!_client) _client = new Anthropic();
  return _client;
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

const STRUCTURED_RESULT_TOOL = "return_result";

function resultFromAnthropicToolUse<T>(res: any): T {
  const content = Array.isArray(res?.content) ? res.content : [];
  const toolUse = content.find(
    (block: any) => block?.type === "tool_use" && block?.name === STRUCTURED_RESULT_TOOL
  );
  if (!toolUse) {
    throw new Error(`Model did not call required tool: ${STRUCTURED_RESULT_TOOL}`);
  }
  const input = toolUse.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`Model returned invalid tool input for ${STRUCTURED_RESULT_TOOL}.`);
  }
  return input as T;
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
  const model = deps.model ?? ANTHROPIC_DEFAULT_MODEL;
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
  const structuredImpl = async <T>(
    args: StructuredArgs,
    userContent: unknown
  ): Promise<T> => {
    const callModel = pickModel(args.effort);
    const res = await ensureCreate()({
      model: callModel,
      max_tokens: args.maxTokens ?? 8000,
      system: [
        {
          type: "text",
          text: args.cachedSystem,
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: [
        {
          name: STRUCTURED_RESULT_TOOL,
          description: "Return the structured result for this task.",
          input_schema: args.schema,
        },
      ],
      tool_choice: { type: "tool", name: STRUCTURED_RESULT_TOOL },
      messages: [{ role: "user", content: userContent }],
    });
    return resultFromAnthropicToolUse<T>(res);
  };

  return {
    provider: "anthropic",
    model,
    modelFor: pickModel,
    structured<T>(args: StructuredArgs) {
      return structuredImpl<T>(args, args.user);
    },
    async structuredVision<T>(args: StructuredVisionArgs) {
      const { promises: fs } = await import("node:fs");
      const imageBlocks = await Promise.all(
        args.images.map(async (image) => {
          const bytes = await fs.readFile(image.path);
          return {
            type: "image",
            source: {
              type: "base64",
              media_type: image.mediaType,
              data: bytes.toString("base64"),
            },
          };
        })
      );
      return structuredImpl<T>(args, [
        { type: "text", text: args.user },
        ...imageBlocks,
      ]);
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
