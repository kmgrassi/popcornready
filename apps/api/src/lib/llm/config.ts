import { MODEL as ANTHROPIC_DEFAULT_MODEL } from "../anthropic";
import type { LlmProvider } from "./types";

export interface LlmConfig {
  provider: LlmProvider;
  openaiModel: string;
  anthropicModel: string;
}

const PROVIDERS = new Set<LlmProvider>(["openai", "anthropic"]);

// Provider selection is env-driven and defaults to OpenAI. Models are
// overridable per provider; Anthropic falls back to lib/anthropic's MODEL.
export function resolveLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const provider = (env.LLM_PROVIDER || "openai").trim().toLowerCase();
  if (!PROVIDERS.has(provider as LlmProvider)) {
    throw new Error(
      `Unknown LLM_PROVIDER "${provider}". Expected one of: openai, anthropic.`
    );
  }
  return {
    provider: provider as LlmProvider,
    openaiModel: (env.OPENAI_MODEL || "gpt-5").trim(),
    anthropicModel: (env.ANTHROPIC_MODEL || ANTHROPIC_DEFAULT_MODEL).trim(),
  };
}
