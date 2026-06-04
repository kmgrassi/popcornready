import type { EvaluatorContext, UnsafeEvaluatorContextInput } from "./types";

const FORBIDDEN_CONTEXT_KEYS = [
  "generatorPrompt",
  "generatorMessages",
  "chainOfThought",
  "workingContext",
] as const;

export function createEvaluatorContext(
  input: UnsafeEvaluatorContextInput
): EvaluatorContext {
  for (const key of FORBIDDEN_CONTEXT_KEYS) {
    if (input[key] !== undefined) {
      throw new Error(`EvaluatorContext must not include generator-private field: ${key}`);
    }
  }

  return {
    stageType: input.stageType,
    tool: input.tool,
    modality: input.modality,
    artifact: input.artifact,
    intent: input.intent == null ? undefined : structuredClone(input.intent),
    expectations: input.expectations ? structuredClone(input.expectations) : undefined,
    evidenceRef: input.evidenceRef,
    caseId: input.caseId,
    stageId: input.stageId,
    itemId: input.itemId,
    artifactId: input.artifactId,
    assetId: input.assetId,
    trigger: input.trigger,
  };
}
