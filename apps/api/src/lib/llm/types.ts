// Provider-neutral LLM contracts. The agent brain (structured-output calls and
// the orchestrator tool loop) talks to an LlmClient; concrete providers
// (OpenAI, Anthropic) are adapters behind it. See ./index getLlmClient.

export type LlmProvider = "openai" | "anthropic";

// How hard the model should "think". Maps to OpenAI reasoning_effort and to
// Anthropic output_config.effort. "minimal" ≈ non-reasoning (fast/cheap) — use
// it for straightforward generation/extraction (e.g. cleaning a prompt); use
// "high" only where the task needs real planning/judgement. Unset → the
// provider default (treated as "medium").
export type LlmEffort = "minimal" | "low" | "medium" | "high";

export type JsonSchema = Record<string, unknown>;

// A tool the model may choose to call, in a provider-neutral shape. Adapters
// map this to OpenAI `function` tools or Anthropic `input_schema` tools.
export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export type ToolChoiceResult =
  | {
      type: "tool_call";
      toolName: string;
      input: Record<string, unknown>;
      model: string;
    }
  | {
      type: "done";
      text: string;
      model: string;
    };

export interface StructuredArgs {
  // The large, stable system prompt (instructions + catalog). On Anthropic this
  // is cache-controlled; on OpenAI it is the system message (auto-cached).
  cachedSystem: string;
  user: string;
  schema: JsonSchema;
  maxTokens?: number;
  effort?: LlmEffort;
}

export interface StructuredVisionImage {
  path: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
}

export interface StructuredVisionArgs extends StructuredArgs {
  images: StructuredVisionImage[];
}

export interface ChooseToolArgs {
  system: string;
  userPayload: unknown;
  tools: ToolSpec[];
  maxTokens?: number;
  effort?: LlmEffort;
}

export interface LlmClient {
  readonly provider: LlmProvider;
  readonly model: string;
  // JSON-schema-constrained structured output (planEdit/critique/revise/…).
  structured<T>(args: StructuredArgs): Promise<T>;
  structuredVision<T>(args: StructuredVisionArgs): Promise<T>;
  // One tool-calling turn: pick the next tool, or finish with text.
  chooseTool(args: ChooseToolArgs): Promise<ToolChoiceResult>;
}

export function parseStructuredText<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      "Model did not return valid JSON. Raw output: " + text.slice(0, 500)
    );
  }
}
