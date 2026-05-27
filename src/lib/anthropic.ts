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
}

// One structured JSON call. Uses output_config.format to constrain the
// response to the given JSON schema, so we can JSON.parse the text block
// safely. Cast to any keeps this resilient to SDK type-version drift while
// the runtime fully supports output_config on Opus 4.7.
export async function structuredCall<T>({
  cachedSystem,
  user,
  schema,
  maxTokens = 8000,
}: StructuredCallArgs): Promise<T> {
  const res: any = await client().messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system: [
      {
        type: "text",
        text: cachedSystem,
        cache_control: { type: "ephemeral" },
      },
    ],
    output_config: {
      effort: "high",
      format: { type: "json_schema", schema },
    },
    messages: [{ role: "user", content: user }],
  } as any);

  const text: string =
    (res.content || [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("") || "";

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      "Model did not return valid JSON. Raw output: " + text.slice(0, 500)
    );
  }
}
