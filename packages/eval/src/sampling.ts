import type { EvaluationTarget, Evaluator, EvalModality } from "./types";

export interface SamplingPolicy {
  textStructuredRate: 1;
  mediaClipRate: number;
}

export const DEFAULT_OBSERVATIONAL_SAMPLING: SamplingPolicy = {
  textStructuredRate: 1,
  mediaClipRate: 1,
};

const TEXT_STRUCTURED_MODALITIES = new Set<EvalModality>(["plan", "timeline"]);
const MEDIA_MODALITIES = new Set<EvalModality>(["image", "video", "audio"]);

export function shouldRunEvaluator(args: {
  evaluator: Pick<Evaluator, "mode" | "modality">;
  target: Pick<EvaluationTarget, "itemId" | "artifactId" | "assetId">;
  policy?: SamplingPolicy;
}): boolean {
  const { evaluator, target } = args;
  const policy = args.policy ?? DEFAULT_OBSERVATIONAL_SAMPLING;

  if (evaluator.mode === "blocking_gate") {
    return true;
  }

  if (TEXT_STRUCTURED_MODALITIES.has(evaluator.modality)) {
    return true;
  }

  if (MEDIA_MODALITIES.has(evaluator.modality)) {
    const clipKey = target.itemId ?? target.artifactId ?? target.assetId;
    if (!clipKey) {
      return false;
    }
    return deterministicSample(clipKey, clampRate(policy.mediaClipRate));
  }

  return deterministicSample(
    target.itemId ?? target.artifactId ?? target.assetId ?? "unkeyed",
    clampRate(policy.textStructuredRate)
  );
}

function clampRate(rate: number): number {
  if (Number.isNaN(rate)) return 0;
  return Math.min(1, Math.max(0, rate));
}

function deterministicSample(key: string, rate: number): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;

  return hashToUnitInterval(key) < rate;
}

function hashToUnitInterval(key: string): number {
  let hash = 2166136261;

  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0) / 0xffffffff;
}
