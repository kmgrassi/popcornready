import { ANTHROPIC_DEFAULT_MODEL } from "./anthropic";
import type { LlmProvider } from "./types";

export interface LlmConfig {
  provider: LlmProvider;
  openaiModel: string;
  // Cheaper/faster model used for low-reasoning calls (minimal/low effort).
  openaiFastModel: string;
  anthropicModel: string;
  anthropicFastModel: string;
}

const PROVIDERS = new Set<LlmProvider>(["openai", "anthropic"]);

// Provider selection is env-driven and defaults to OpenAI. Models are
// overridable per provider; Anthropic falls back to ANTHROPIC_DEFAULT_MODEL.
export function resolveLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const provider = (env.LLM_PROVIDER || "openai").trim().toLowerCase();
  if (!PROVIDERS.has(provider as LlmProvider)) {
    throw new Error(
      `Unknown LLM_PROVIDER "${provider}". Expected one of: openai, anthropic.`
    );
  }
  const openaiModel = (env.OPENAI_MODEL || "gpt-5").trim();
  const anthropicModel = (env.ANTHROPIC_MODEL || ANTHROPIC_DEFAULT_MODEL).trim();
  return {
    provider: provider as LlmProvider,
    openaiModel,
    // Default the fast lane to gpt-5-mini; falls back to the primary model if a
    // deployment doesn't have a mini variant configured.
    openaiFastModel: (env.OPENAI_FAST_MODEL || "gpt-5-mini").trim() || openaiModel,
    anthropicModel,
    anthropicFastModel:
      (env.ANTHROPIC_FAST_MODEL || "claude-haiku-4-5").trim() || anthropicModel,
  };
}

// Whether the configured provider has an API key, for callers that degrade
// gracefully (skip an optional review) instead of throwing mid-pipeline.
export function hasLlmCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  const { provider } = resolveLlmConfig(env);
  const key = provider === "openai" ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY;
  return Boolean(key?.trim());
}
