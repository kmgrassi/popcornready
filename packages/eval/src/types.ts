import type { GenerationStageType } from "@popcorn/shared/v1/types";

export type { GenerationStageType };

export type EvalModality = "plan" | "image" | "video" | "audio" | "timeline";

export type EvidenceKind =
  | "artifact_json"
  | "frames"
  | "rendered_preview"
  | "boundary_frames";

export type EvaluatorStyle = "reference_free" | "expectation_aware";

export type EvaluatorMode = "blocking_gate" | "observational";

export type JudgmentVerdict = "pass" | "needs_review" | "fail";

export type JudgmentTrigger = "auto" | "manual";

export type RecommendedAction = "keep" | "regenerate" | "manual_review";

export type JudgmentGrade = number | JudgmentVerdict;

export interface EvaluatorContext {
  stageType: GenerationStageType;
  tool?: string;
  modality: EvalModality;
  artifact: unknown;
  intent?: unknown;
  expectations?: CaseExpectation[];
  evidenceRef?: string;
  caseId?: string;
  stageId: string;
  itemId?: string;
  artifactId?: string;
  assetId?: string;
  trigger: JudgmentTrigger;
}

export interface JudgmentDraft {
  grades: Record<string, JudgmentGrade>;
  rationale: string;
  recommendedAction?: RecommendedAction;
  evidenceRef?: string;
  expectationChecks?: ExpectationCheck[];
  costUsd?: number;
  latencyMs?: number;
}

export interface Evaluator {
  id: string;
  stageType: GenerationStageType;
  tool?: string;
  modality: EvalModality;
  rubricVersion: string;
  judgeModel: string;
  schema: unknown;
  evidenceNeeded: EvidenceKind[];
  style: EvaluatorStyle;
  mode: EvaluatorMode;
  thresholds: Record<string, number>;
  run(ctx: EvaluatorContext): Promise<JudgmentDraft>;
}

export interface Judgment {
  id: string;
  evaluatorId: string;
  rubricVersion: string;
  judgeModel: string;
  generationRunId?: string;
  evalRunId?: string;
  caseId?: string;
  stageId: string;
  itemId?: string;
  artifactId?: string;
  assetId?: string;
  grades: Record<string, JudgmentGrade>;
  verdict: JudgmentVerdict;
  rationale: string;
  recommendedAction?: RecommendedAction;
  evidenceRef?: string;
  trigger: JudgmentTrigger;
  costUsd: number;
  latencyMs: number;
  createdAt: string;
}

export interface EvalSuite {
  id: string;
  name: string;
  description?: string;
}

export interface EvalCase {
  id: string;
  suiteId: string;
  label: string;
  stimulus:
    | {
        kind: "brief";
        goal: string;
        targetLengthSec: number;
        style: string;
        aspectRatio: string;
      }
    | {
        kind: "frozen_artifact";
        stageType: GenerationStageType;
        artifact: unknown;
      };
  stagesToRun: GenerationStageType[];
  expectations?: CaseExpectation[];
}

export interface CaseExpectation {
  stageType: GenerationStageType;
  gradeFloors?: Record<string, number>;
  goldenArtifactId?: string;
  assertions?: string[];
}

export type ExpectationCheck =
  | {
      kind: "golden_artifact";
      goldenArtifactId: string;
      matched: boolean;
      detail?: string;
    }
  | {
      kind: "assertion";
      assertion: string;
      matched: boolean;
      detail?: string;
    };

export interface EvalRun {
  id: string;
  source: "suite" | "manual_workbench";
  suiteId?: string;
  generationMode: "prompts_only" | "full";
  stopAfter?: GenerationStageType;
  gitSha: string;
  branch: string;
  judgeModels: Record<string, string>;
  status: "queued" | "running" | "succeeded" | "failed";
  aggregate?: Record<string, number>;
  createdAt: string;
  completedAt?: string;
}

export interface ExpectationResult {
  evalRunId: string;
  caseId: string;
  judgmentId: string;
  matched: boolean;
  detail?: string;
}
export interface EvalFixtureArtifact {
  stageType: GenerationStageType;
  tool?: string;
  itemId?: string;
  artifactId?: string;
  assetId?: string;
  artifact: unknown;
  intent?: unknown;
  evidenceRef?: string;
}

export interface EvalFixtureCase extends EvalCase {
  artifacts: EvalFixtureArtifact[];
}

export interface EvalSuiteFixture {
  suite: EvalSuite;
  cases: EvalFixtureCase[];
}

export interface EvalRunResult {
  evalRun: EvalRun;
  judgments: Judgment[];
  expectationResults: ExpectationResult[];
}
