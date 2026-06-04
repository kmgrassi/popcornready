import type { GenerationJudgmentVerdict } from "@popcorn/shared/v1/types";

export type EvalRunSource = "suite" | "manual_workbench";
export type EvalGenerationMode = "prompts_only" | "full";

export interface EvalSuiteSummary {
  suiteId: string;
  name: string;
  description: string;
  latestPassRate: number;
  latestRunId: string;
  trend: number[];
  stageRates: Array<{
    stage: string;
    passRate: number;
    verdict: GenerationJudgmentVerdict;
  }>;
}

export interface EvalRunGridCell {
  caseId: string;
  stage: string;
  verdict: GenerationJudgmentVerdict;
  evaluatorId: string;
  rationale: string;
  evidenceLabel: string;
}

export interface EvalRunDetail {
  runId: string;
  source: EvalRunSource;
  suiteName: string;
  generationMode: EvalGenerationMode;
  branch: string;
  gitSha: string;
  createdAt: string;
  passRate: number;
  cases: Array<{ caseId: string; label: string }>;
  stages: string[];
  cells: EvalRunGridCell[];
  flippedVerdicts: Array<{
    caseLabel: string;
    stage: string;
    before: GenerationJudgmentVerdict;
    after: GenerationJudgmentVerdict;
  }>;
  calibration: {
    matchRate: number;
    labeledCases: number;
  };
}

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

export const evalSuites: EvalSuiteSummary[] = [
  {
    suiteId: "suite-longform-core",
    name: "Long-form core regression",
    description: "Story arc, prompt readiness, media review, and timeline assembly.",
    latestPassRate: 0.89,
    latestRunId: "evalrun_20260604_1042",
    trend: [0.82, 0.85, 0.84, 0.88, 0.89],
    stageRates: [
      { stage: "Story arc", passRate: 0.94, verdict: "pass" },
      { stage: "Character prompts", passRate: 0.86, verdict: "needs_review" },
      { stage: "Clip prompts", passRate: 0.9, verdict: "pass" },
      { stage: "Timeline", passRate: 0.82, verdict: "needs_review" },
    ],
  },
  {
    suiteId: "suite-broken-fixtures",
    name: "Known-good / known-bad calibration",
    description: "Labeled fixtures that confirm judges catch deliberately broken outputs.",
    latestPassRate: 0.93,
    latestRunId: "evalrun_20260604_0915",
    trend: [0.91, 0.92, 0.9, 0.94, 0.93],
    stageRates: [
      { stage: "Story arc", passRate: 0.96, verdict: "pass" },
      { stage: "Keyframes", passRate: 0.92, verdict: "pass" },
      { stage: "Continuity", passRate: 0.88, verdict: "needs_review" },
    ],
  },
];

export const evalRunDetail: EvalRunDetail = {
  runId: "evalrun_20260604_1042",
  source: "suite",
  suiteName: "Long-form core regression",
  generationMode: "prompts_only",
  branch: "codex/stage-eval-core",
  gitSha: "8389b5d",
  createdAt: "2026-06-04T10:42:00.000Z",
  passRate: 0.89,
  cases: [
    { caseId: "case-launch-doc", label: "Launch documentary arc" },
    { caseId: "case-founder", label: "Founder profile" },
    { caseId: "case-cooking", label: "Cooking lesson" },
  ],
  stages: ["Story arc", "Character prompts", "Clip prompts", "Timeline"],
  cells: [
    {
      caseId: "case-launch-doc",
      stage: "Story arc",
      verdict: "pass",
      evaluatorId: "story_arc.v2",
      rationale: "Clear three-part arc with a specific conflict and resolution.",
      evidenceLabel: "creative_plan.json",
    },
    {
      caseId: "case-launch-doc",
      stage: "Character prompts",
      verdict: "needs_review",
      evaluatorId: "asset_prompt.v1",
      rationale: "Primary subject is consistent, but wardrobe detail drifts between anchors.",
      evidenceLabel: "anchor_prompts.json",
    },
    {
      caseId: "case-launch-doc",
      stage: "Clip prompts",
      verdict: "pass",
      evaluatorId: "clip_prompt.v1",
      rationale: "Every beat prompt preserves scene intent and camera direction.",
      evidenceLabel: "beat_prompts.json",
    },
    {
      caseId: "case-launch-doc",
      stage: "Timeline",
      verdict: "pass",
      evaluatorId: "timeline_assembly.v1",
      rationale: "Beat order and durations match the planned rhythm.",
      evidenceLabel: "timeline.json",
    },
    {
      caseId: "case-founder",
      stage: "Story arc",
      verdict: "pass",
      evaluatorId: "story_arc.v2",
      rationale: "The plan turns the founder bio into a visible before and after.",
      evidenceLabel: "creative_plan.json",
    },
    {
      caseId: "case-founder",
      stage: "Character prompts",
      verdict: "pass",
      evaluatorId: "asset_prompt.v1",
      rationale: "Character anchors preserve age, clothing, and setting constraints.",
      evidenceLabel: "anchor_prompts.json",
    },
    {
      caseId: "case-founder",
      stage: "Clip prompts",
      verdict: "pass",
      evaluatorId: "clip_prompt.v1",
      rationale: "Clip prompts include enough action to avoid static talking-head output.",
      evidenceLabel: "beat_prompts.json",
    },
    {
      caseId: "case-founder",
      stage: "Timeline",
      verdict: "needs_review",
      evaluatorId: "timeline_assembly.v1",
      rationale: "Two adjacent beats repeat the same proof point and slow the middle.",
      evidenceLabel: "timeline.json",
    },
    {
      caseId: "case-cooking",
      stage: "Story arc",
      verdict: "pass",
      evaluatorId: "story_arc.v2",
      rationale: "The steps build from prep to payoff with a clear hook.",
      evidenceLabel: "creative_plan.json",
    },
    {
      caseId: "case-cooking",
      stage: "Character prompts",
      verdict: "pass",
      evaluatorId: "asset_prompt.v1",
      rationale: "Hands, tools, and kitchen references remain stable.",
      evidenceLabel: "anchor_prompts.json",
    },
    {
      caseId: "case-cooking",
      stage: "Clip prompts",
      verdict: "fail",
      evaluatorId: "clip_prompt.v1",
      rationale: "The third beat asks for the finished dish before the cooking action.",
      evidenceLabel: "beat_prompts.json",
    },
    {
      caseId: "case-cooking",
      stage: "Timeline",
      verdict: "needs_review",
      evaluatorId: "timeline_assembly.v1",
      rationale: "Duration is acceptable, but the beat order should be rechecked.",
      evidenceLabel: "timeline.json",
    },
  ],
  flippedVerdicts: [
    {
      caseLabel: "Cooking lesson",
      stage: "Clip prompts",
      before: "pass",
      after: "fail",
    },
    {
      caseLabel: "Founder profile",
      stage: "Timeline",
      before: "pass",
      after: "needs_review",
    },
  ],
  calibration: {
    matchRate: 0.93,
    labeledCases: 27,
  },
};

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
