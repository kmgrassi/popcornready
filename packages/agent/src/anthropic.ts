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
  // catalog) can be cached across calls in one generation. Caching is a prefix
  // match, so stable content goes here.
  cachedSystem: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
}

export interface StructuredVisionImage {
  path: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
}

export interface StructuredVisionCallArgs extends StructuredCallArgs {
  images: StructuredVisionImage[];
}

function parseStructuredText<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      "Model did not return valid JSON. Raw output: " + text.slice(0, 500)
    );
  }
}

// One structured JSON vision call. Uses output_config.format to constrain the
// response to the given JSON schema, so we can JSON.parse the text block safely.
// Cast to any keeps this resilient to SDK type-version drift while the runtime
// fully supports output_config on Opus 4.7.
export async function structuredVisionCall<T>({
  cachedSystem,
  user,
  schema,
  images,
  maxTokens = 4000,
}: StructuredVisionCallArgs): Promise<T> {
  const { promises: fs } = await import("node:fs");
  const imageBlocks = await Promise.all(
    images.map(async (image) => {
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
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: user }, ...imageBlocks],
      },
    ],
  } as any);

  const text: string =
    (res.content || [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("") || "";

  return parseStructuredText<T>(text);
}
