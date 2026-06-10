import OpenAI from "openai";

import {
  ChooseToolArgs,
  JsonSchema,
  LlmClient,
  LlmEffort,
  StructuredArgs,
  StructuredVisionArgs,
  ToolChoiceResult,
  ToolSpec,
} from "./types";

// Reasoning models accept `reasoning_effort`; non-reasoning models (gpt-4o,
// gpt-4.1) reject it, so only send it when the model is a reasoning one.
const REASONING_MODEL = /^(gpt-5|o[1-9])/i;

function reasoningParams(
  model: string,
  effort?: LlmEffort
): Record<string, unknown> {
  if (!effort || !REASONING_MODEL.test(model)) return {};
  return { reasoning_effort: effort };
}

// Loose typing on the wire call keeps us resilient to SDK type-version drift and
// lets us pass reasoning-model params (max_completion_tokens) the strict types
// may not yet expose — mirrors the `as any` pattern in ./anthropic.ts.
type ChatCreate = (params: Record<string, unknown>) => Promise<any>;

// Low-reasoning calls route to the cheaper fast model.
const FAST_EFFORTS = new Set<LlmEffort>(["minimal", "low"]);

export interface OpenAiDeps {
  model: string;
  // Cheaper model for minimal/low-effort calls. Defaults to `model`.
  fastModel?: string;
  // Injected in tests; defaults to the real OpenAI client lazily.
  create?: ChatCreate;
}

export function toOpenAITool(spec: ToolSpec): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
    },
  };
}

const STRUCTURED_RESULT_TOOL = "return_result";

// OpenAI's function tool parameters reject several JSON Schema keywords that
// our schemas use (minLength, minimum, ...). With strict:false the model still
// follows the schema; we strip unsupported keywords so requests are accepted
// across models.
const UNSUPPORTED_SCHEMA_KEYS = new Set([
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "min",
  "max",
  "minItems",
  "maxItems",
  "pattern",
  "format",
]);

export function sanitizeForOpenAI(schema: JsonSchema): JsonSchema {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        if (UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
        out[key] = walk(val);
      }
      return out;
    }
    return value;
  };
  return walk(schema) as JsonSchema;
}

function toolInputFromOpenAIMessage<T>(
  message: any,
  expectedTool: string
): T {
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  const call = calls.find(
    (candidate: any) => candidate?.function?.name === expectedTool
  );
  const raw = call?.function?.arguments;
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error(`Model did not call required tool: ${expectedTool}`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `Model returned invalid tool arguments for ${expectedTool}: ${raw.slice(0, 500)}`
    );
  }
}

// Pure response parsing — unit-tested without a network call.
export function interpretOpenAiToolResponse(
  res: any,
  fallbackModel: string
): ToolChoiceResult {
  const message = res?.choices?.[0]?.message;
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  const model = res?.model ?? fallbackModel;

  if (calls.length > 0) {
    // The orchestrator asks for one tool at a time; if the model returns several
    // (parallel tool calls), act on the first and ignore the rest.
    const call = calls[0];
    let input: Record<string, unknown> = {};
    const raw = call?.function?.arguments;
    if (typeof raw === "string" && raw.trim()) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          input = parsed as Record<string, unknown>;
        }
      } catch {
        // Malformed arguments → empty input; the registry will reject if needed.
      }
    }
    return {
      type: "tool_call",
      toolName: String(call?.function?.name ?? ""),
      input,
      model,
    };
  }

  return { type: "done", text: String(message?.content ?? "").trim(), model };
}

export function createOpenAiLlmClient(deps: OpenAiDeps): LlmClient {
  let create = deps.create;
  const ensureCreate = (): ChatCreate => {
    if (create) return create;
    const client = new OpenAI();
    create = client.chat.completions.create.bind(
      client.chat.completions
    ) as unknown as ChatCreate;
    return create;
  };
  const model = deps.model;
  const fastModel = deps.fastModel ?? model;
  const pickModel = (effort?: LlmEffort): string =>
    effort && FAST_EFFORTS.has(effort) ? fastModel : model;

  const structuredImpl = async <T>(
    args: StructuredArgs,
    userContent: unknown
  ): Promise<T> => {
    const callModel = pickModel(args.effort);
    const tool = toOpenAITool({
      name: STRUCTURED_RESULT_TOOL,
      description: "Return the structured result for this task.",
      parameters: sanitizeForOpenAI(args.schema),
    });
    const res = await ensureCreate()({
      model: callModel,
      messages: [
        { role: "system", content: args.cachedSystem },
        { role: "user", content: userContent },
      ],
      tools: [tool],
      tool_choice: { type: "function", function: { name: STRUCTURED_RESULT_TOOL } },
      parallel_tool_calls: false,
      max_completion_tokens: args.maxTokens ?? 8000,
      ...reasoningParams(callModel, args.effort),
    });
    return toolInputFromOpenAIMessage<T>(
      res?.choices?.[0]?.message,
      STRUCTURED_RESULT_TOOL
    );
  };

  return {
    provider: "openai",
    model,
    modelFor: pickModel,
    structured<T>(args: StructuredArgs) {
      return structuredImpl<T>(args, args.user);
    },
    async structuredVision<T>(args: StructuredVisionArgs) {
      const { promises: fs } = await import("node:fs");
      const parts: unknown[] = [{ type: "text", text: args.user }];
      for (const image of args.images) {
        const bytes = await fs.readFile(image.path);
        parts.push({
          type: "image_url",
          image_url: {
            url: `data:${image.mediaType};base64,${bytes.toString("base64")}`,
          },
        });
      }
      return structuredImpl<T>(args, parts);
    },
    async chooseTool(args: ChooseToolArgs) {
      const callModel = pickModel(args.effort);
      const res = await ensureCreate()({
        model: callModel,
        messages: [
          { role: "system", content: args.system },
          { role: "user", content: JSON.stringify(args.userPayload) },
        ],
        tools: args.tools.map(toOpenAITool),
        tool_choice: "auto",
        parallel_tool_calls: false,
        max_completion_tokens: args.maxTokens ?? 2000,
        ...reasoningParams(callModel, args.effort),
      });
      return interpretOpenAiToolResponse(res, callModel);
    },
  };
}
