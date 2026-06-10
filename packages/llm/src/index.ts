import { createAnthropicLlmClient } from "./anthropic";
import { resolveLlmConfig } from "./config";
import { createOpenAiLlmClient } from "./openai";
import type { LlmClient } from "./types";

export * from "./types";
export { hasLlmCredentials, resolveLlmConfig } from "./config";
export type { LlmConfig } from "./config";
export {
  ANTHROPIC_DEFAULT_MODEL,
  createAnthropicLlmClient,
  interpretAnthropicToolResponse,
  toAnthropicTool,
} from "./anthropic";
export {
  createOpenAiLlmClient,
  interpretOpenAiToolResponse,
  sanitizeForOpenAI,
  toOpenAITool,
} from "./openai";

let cache: { key: string; client: LlmClient } | null = null;

// The configured agent-brain client. Defaults to OpenAI (gpt-5); set
// LLM_PROVIDER=anthropic to swap. Memoized per resolved config so the
// underlying SDK client is constructed once.
export function getLlmClient(env: NodeJS.ProcessEnv = process.env): LlmClient {
  const config = resolveLlmConfig(env);
  const key = [
    config.provider,
    config.openaiModel,
    config.openaiFastModel,
    config.anthropicModel,
    config.anthropicFastModel,
  ].join(":");
  if (cache && cache.key === key) return cache.client;

  const client =
    config.provider === "openai"
      ? createOpenAiLlmClient({
          model: config.openaiModel,
          fastModel: config.openaiFastModel,
        })
      : createAnthropicLlmClient({
          model: config.anthropicModel,
          fastModel: config.anthropicFastModel,
        });

  cache = { key, client };
  return client;
}
