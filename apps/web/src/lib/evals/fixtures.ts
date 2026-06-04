import type { GenerationJudgmentVerdict } from "@popcorn/shared/v1/types";

// Seed data for the admin workbench artifact board. The board is driven by a
// real `manual_workbench` generation run once generation-runs accepts the
// `prompts_only` + `stopAfter` params; until then it renders this fixture and
// the per-card "Run judge" action hits the real `POST /judgments` endpoint.
// See AdminEvalsPage for the TODO.

export type EvalGenerationMode = "prompts_only" | "full";

export interface WorkbenchArtifact {
  artifactId: string;
  stage: string;
  title: string;
  kind: "plan" | "image_prompt" | "video_prompt" | "audio_spec" | "timeline";
  status: "ready" | "judged" | "needs_revision";
  verdict?: GenerationJudgmentVerdict;
  score?: number;
  rationale?: string;
}

export interface WorkbenchStory {
  evalRunId: string;
  title: string;
  mode: EvalGenerationMode;
  stopAfter: string;
  scorecard: Array<{
    stage: string;
    verdict: GenerationJudgmentVerdict;
    summary: string;
  }>;
  artifacts: WorkbenchArtifact[];
}

export const workbenchStory: WorkbenchStory = {
  evalRunId: "manual_20260604_1120",
  title: "A neighborhood bakery rebuilds after a flood",
  mode: "prompts_only",
  stopAfter: "creative_plan",
  scorecard: [
    {
      stage: "Story arc",
      verdict: "pass",
      summary: "Strong hook, clear emotional turn, specific ending.",
    },
    {
      stage: "Anchor prompts",
      verdict: "needs_review",
      summary: "Main baker is stable, but location details need tightening.",
    },
    {
      stage: "Clip prompts",
      verdict: "pass",
      summary: "Beats are concrete and media-ready before provider calls.",
    },
  ],
  artifacts: [
    {
      artifactId: "artifact_plan_001",
      stage: "Creative plan",
      title: "Three-act recovery arc",
      kind: "plan",
      status: "judged",
      verdict: "pass",
      score: 9,
      rationale: "The conflict, turning point, and payoff are visible and filmable.",
    },
    {
      artifactId: "artifact_anchor_001",
      stage: "Asset prompts",
      title: "Owner portrait anchor",
      kind: "image_prompt",
      status: "needs_revision",
      verdict: "needs_review",
      score: 7,
      rationale: "The person is clear, but the apron color conflicts with the brief.",
    },
    {
      artifactId: "artifact_clip_003",
      stage: "Clip prompts",
      title: "Ovens relight beat",
      kind: "video_prompt",
      status: "ready",
    },
    {
      artifactId: "artifact_audio_001",
      stage: "Audio",
      title: "Warm narration spec",
      kind: "audio_spec",
      status: "ready",
    },
  ],
};
