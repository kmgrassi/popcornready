// Shared types for generation runs.
//
// A "run" represents one end-to-end attempt to turn a prompt or brief into a
// finished video. The UI polls a run to render a progress view; later PRs will
// add finer-grained stage items (per-beat asset cards, audio playback, etc.).
// Run state reuses the existing job state vocabulary so we do not maintain a
// second status taxonomy.

export type GenerationRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

export type GenerationStageType =
  | "brief_intake"
  | "creative_plan"
  | "asset_generation"
  | "audio_generation"
  | "timeline_assembly"
  | "quality_review"
  | "export"
  | "ready";

export interface GenerationErrorSummary {
  code: string;
  message: string;
  retryable: boolean;
}

export interface GenerationStageItem {
  itemId: string;
  stageId: string;
  kind: "image" | "video" | "audio" | "caption" | "timeline" | "export";
  label: string;
  status: GenerationRunStatus;
  progressPercent?: number;
  provider?: string;
  promptPreview?: string;
  assetId?: string;
  artifactId?: string;
  retryable?: boolean;
  error?: GenerationErrorSummary;
}

export interface GenerationStage {
  stageId: string;
  runId: string;
  type: GenerationStageType;
  label: string;
  order: number;
  status: GenerationRunStatus;
  progressPercent?: number;
  message?: string;
  startedAt?: string;
  completedAt?: string;
  jobIds: string[];
  artifactIds: string[];
  items: GenerationStageItem[];
  error?: GenerationErrorSummary;
}

export interface GenerationRunInputs {
  goal: string;
  targetLengthSec: number;
  style: string;
  aspectRatio: string;
  storyContext?: unknown;
}

export interface GenerationRun {
  runId: string;
  projectId: string;
  briefVersionId?: string;
  status: GenerationRunStatus;
  currentStageType?: GenerationStageType;
  progressPercent?: number;
  message?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: GenerationErrorSummary;
  inputs: GenerationRunInputs;
  stages: GenerationStage[];
}

export const RUN_STAGES: { type: GenerationStageType; label: string }[] = [
  { type: "brief_intake", label: "Preparing your video brief" },
  { type: "creative_plan", label: "Planning beats and shots" },
  { type: "asset_generation", label: "Generating visuals" },
  { type: "timeline_assembly", label: "Assembling the timeline" },
  { type: "quality_review", label: "Reviewing the cut" },
  { type: "ready", label: "Your video is ready" },
];
