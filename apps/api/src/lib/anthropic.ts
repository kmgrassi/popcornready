import Anthropic from "@anthropic-ai/sdk";

export const MODEL = "claude-opus-4-7";

let _client: Anthropic | null = null;
export function client(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Copy .env.local.example to .env.local and add your key."
    );
  }
  if (!_client) _client = new Anthropic();
  return _client;
}

export interface StructuredCallArgs {
  // The system prompt is split so the large, stable part (instructions +
  // catalog) can be cached across the planner/selector/critic/reviser calls
  // in one generation. Caching is a prefix match, so stable content goes here.
  cachedSystem: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
  // Override the Claude model (defaults to MODEL). Used by the llm/ adapter so
  // ANTHROPIC_MODEL can select a model without editing this file.
  model?: string;
  // Retained for adapter compatibility; Anthropic tool-calling uses provider
  // defaults for thinking depth.
  effort?: "low" | "medium" | "high" | "max";
}

export interface StructuredVisionImage {
  path: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
}

export interface StructuredVisionCallArgs extends StructuredCallArgs {
  images: StructuredVisionImage[];
}

const STRUCTURED_RESULT_TOOL = "return_result";

function structuredTool(schema: Record<string, unknown>) {
  return {
    name: STRUCTURED_RESULT_TOOL,
    description: "Return the structured result for this task.",
    input_schema: schema,
  };
}

function resultFromToolUse<T>(res: any): T {
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

// One structured call. The model must call `return_result`; its input is the
// typed output object. Cast to any keeps this resilient to SDK type-version
// drift.
export async function structuredCall<T>({
  cachedSystem,
  user,
  schema,
  maxTokens = 8000,
  model = MODEL,
}: StructuredCallArgs): Promise<T> {
  const res: any = await client().messages.create({
    model,
    max_tokens: maxTokens,
    system: [
      {
        type: "text",
        text: cachedSystem,
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [structuredTool(schema)],
    tool_choice: { type: "tool", name: STRUCTURED_RESULT_TOOL },
    messages: [{ role: "user", content: user }],
  } as any);

  return resultFromToolUse<T>(res);
}

export async function structuredVisionCall<T>({
  cachedSystem,
  user,
  schema,
  images,
  maxTokens = 4000,
  model = MODEL,
}: StructuredVisionCallArgs): Promise<T> {
  const imageBlocks = await Promise.all(
    images.map(async (image) => {
      const { promises: fs } = await import("fs");
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

  const res: any = await client().messages.create({
    model,
    max_tokens: maxTokens,
    system: [
      {
        type: "text",
        text: cachedSystem,
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [structuredTool(schema)],
    tool_choice: { type: "tool", name: STRUCTURED_RESULT_TOOL },
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: user }, ...imageBlocks],
      },
    ],
  } as any);

  return resultFromToolUse<T>(res);
}
