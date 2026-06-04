import type { GenerationStageType } from "@popcorn/shared/v1/types";
import type { EvalModality, EvaluatorMode } from "./types";

export interface EvaluatorPolicy {
  id: string;
  stageType: GenerationStageType;
  modality: EvalModality;
  mode: EvaluatorMode;
  sampleRate: number;
  sampleUnit: "artifact" | "clip" | "cut";
}

export const DEFAULT_EVALUATOR_POLICIES: readonly EvaluatorPolicy[] = [
  {
    id: "story_arc.v1",
    stageType: "creative_plan",
    modality: "plan",
    mode: "blocking_gate",
    sampleRate: 1,
    sampleUnit: "artifact",
  },
  {
    id: "asset_prompt.v1",
    stageType: "asset_generation",
    modality: "image",
    mode: "blocking_gate",
    sampleRate: 1,
    sampleUnit: "artifact",
  },
  {
    id: "clip_review.v1",
    stageType: "asset_generation",
    modality: "video",
    mode: "observational",
    sampleRate: 1,
    sampleUnit: "clip",
  },
  {
    id: "timeline_assembly.v1",
    stageType: "timeline_assembly",
    modality: "timeline",
    mode: "observational",
    sampleRate: 1,
    sampleUnit: "artifact",
  },
  {
    id: "stitch_continuity.v1",
    stageType: "export",
    modality: "video",
    mode: "observational",
    sampleRate: 1,
    sampleUnit: "cut",
  },
];

export function defaultPolicyFor(evaluatorId: string): EvaluatorPolicy | undefined {
  return DEFAULT_EVALUATOR_POLICIES.find((policy) => policy.id === evaluatorId);
}
