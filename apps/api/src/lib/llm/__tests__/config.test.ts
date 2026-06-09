import assert from "node:assert/strict";
import test from "node:test";

import { resolveLlmConfig } from "../config";

test("defaults to OpenAI / gpt-5", () => {
  const config = resolveLlmConfig({});
  assert.equal(config.provider, "openai");
  assert.equal(config.openaiModel, "gpt-5");
});

test("LLM_PROVIDER=anthropic selects anthropic + a claude model", () => {
  const config = resolveLlmConfig({ LLM_PROVIDER: "anthropic" });
  assert.equal(config.provider, "anthropic");
  assert.ok(
    config.anthropicModel.startsWith("claude"),
    `expected a claude model, got ${config.anthropicModel}`
  );
});

test("OPENAI_MODEL / ANTHROPIC_MODEL override the defaults", () => {
  const config = resolveLlmConfig({
    OPENAI_MODEL: "gpt-4o",
    ANTHROPIC_MODEL: "claude-opus-4-8",
  });
  assert.equal(config.openaiModel, "gpt-4o");
  assert.equal(config.anthropicModel, "claude-opus-4-8");
});

test("provider is trimmed and case-insensitive", () => {
  assert.equal(resolveLlmConfig({ LLM_PROVIDER: " Anthropic " }).provider, "anthropic");
});

test("an unknown provider throws", () => {
  assert.throws(
    () => resolveLlmConfig({ LLM_PROVIDER: "bedrock" }),
    /Unknown LLM_PROVIDER/
  );
});
