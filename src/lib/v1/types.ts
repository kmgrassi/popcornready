// Shared /api/v1 contract types.
//
// These describe the resources the versioned agent API operates on. Most of
// these entities (projects, brief versions, assets, compositions) are created
// and owned by the PR1-PR3 foundation; PR4 (timeline generation) only reads
// them and writes Jobs + VersionedTimelines. They live here as the agreed
// contract so every PR builds against the same shapes.

import { AspectRatio, CriticReport, StoryContext, TimelineSegment } from "../types";

export type { AspectRatio } from "../types";

export const SCHEMA = {
  project: "project.v1",
  briefVersion: "brief.v1",
  asset: "asset.v1",
  composition: "composition.v1",
  timeline: "timeline.v1",
  job: "job.v1",
} as const;

// --- Project (PR1) ---------------------------------------------------------

export type ProjectStatus = "active" | "deleted";

export interface V1Project {
  id: string;
  schemaVersion: typeof SCHEMA.project;
  workspaceId: string;
  name: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
}

// --- Brief (PR1) -----------------------------------------------------------

export interface VideoBriefInput {
  goal: string;
  targetLengthSec: number;
  aspectRatio: AspectRatio;
  platform?: StoryContext["platform"];
  audience?: string;
  style?: string;
  format?: StoryContext["format"];
  narration?: {
    mode: "none" | "generate" | "provided_text" | "provided_asset";
    script?: string;
    voiceId?: string;
    audioAssetId?: string;
  };
  constraints?: {
    mustUseAssetIds?: string[];
    avoidAssetIds?: string[];
    requiredBeats?: string[];
    forbiddenClaims?: string[];
    brandVoice?: string;
    callToAction?: string;
  };
}

export interface BriefVersion {
  id: string;
  schemaVersion: typeof SCHEMA.briefVersion;
  projectId: string;
  brief: VideoBriefInput;
  createdAt: string;
}

// --- Asset (PR1/PR2) -------------------------------------------------------

export type AssetKind = "video" | "image" | "audio";
export type AssetStatus = "pending" | "processing" | "ready" | "failed";

export interface V1Asset {
  id: string;
  schemaVersion: typeof SCHEMA.asset;
  projectId: string;
  workspaceId: string;
  kind: AssetKind;
  status: AssetStatus;
  filename: string;
  url: string; // served/managed path the renderer can read
  durationSec: number;
  description?: string;
  source: "upload" | "remote_url" | "local_path" | "generated";
  // Set when this asset was produced by a PR2 generated-asset job.
  generatedAssetJobId?: string;
  createdAt: string;
  updatedAt: string;
}

// --- Composition (PR3) -----------------------------------------------------

export type CompositionMode = "asset_driven" | "prompt_only" | "hybrid";
export type CompositionStatus =
  | "planning"
  | "generating_assets"
  | "ready_for_timeline"
  | "failed";

export interface PlannedBeat {
  name: string;
  intent: string;
  durationSec: number;
  assetStrategy: "use_existing" | "generate_image" | "generate_video";
  requiredAssetIds?: string[];
  generatedAssetJobIds?: string[];
}

export interface CompositionPlan {
  id: string;
  schemaVersion: typeof SCHEMA.composition;
  projectId: string;
  briefVersionId: string;
  mode: CompositionMode;
  status: CompositionStatus;
  plannedBeats: PlannedBeat[];
  generatedAssetJobIds: string[];
  // Assets the composition resolved/produced that are ready for the timeline.
  readyAssetIds: string[];
  narrationStrategy?: {
    mode: "none" | "provided" | "generate";
    script?: string;
    audioAssetId?: string;
    estimatedDurationSec?: number;
    actualDurationSec?: number;
  };
  createdAt: string;
  updatedAt: string;
}

// --- Jobs ------------------------------------------------------------------

export type JobType =
  | "asset_ingest"
  | "asset_generation"
  | "composition"
  | "generation"
  | "revision"
  | "export"
  | "audio_alignment";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";

export interface JobProgress {
  currentStep?: string;
  percent?: number;
  message?: string;
}

export interface JobError {
  code: string;
  message: string;
}

export interface Job<TInput = unknown, TResult = unknown> {
  id: string;
  schemaVersion: typeof SCHEMA.job;
  workspaceId: string;
  projectId: string;
  type: JobType;
  status: JobStatus;
  progress: JobProgress;
  input: TInput | null;
  result: TResult | null;
  error: JobError | null;
  idempotencyKey?: string;
  createdAt: string;
  updatedAt: string;
}

// --- Timeline (PR4 output) -------------------------------------------------

export interface TimelineProvenance {
  briefVersionId: string;
  compositionId?: string;
  sourceAssetIds: string[];
  generatedAssetJobIds: string[];
  agentClientId?: string;
  modelCallIds?: string[];
  criticReport: CriticReport | null;
  appliedPatchCount: number;
  // Populated by the PR5 audio_alignment step; recorded here for traceability.
  audioAlignment?: {
    decision: string;
    measuredAudioDurationSec?: number;
  };
}

export interface VersionedTimeline {
  id: string;
  schemaVersion: typeof SCHEMA.timeline;
  projectId: string;
  briefVersionId: string;
  compositionId?: string;
  aspectRatio: AspectRatio;
  fps: number;
  segments: TimelineSegment[];
  provenance: TimelineProvenance;
  createdBy: { jobId: string };
  createdAt: string;
}

// --- Generation request/result --------------------------------------------

export interface GenerationRequest {
  briefVersionId?: string;
  assetIds?: string[];
  compositionId?: string;
  variantCount?: number;
  audioAlignment?: {
    mode: string;
    audioAssetId?: string;
  };
}

// Validated, resolved inputs the executor runs against. Stored on the job so
// execution does not re-validate or re-resolve.
export interface GenerationJobInput {
  briefVersionId: string;
  compositionId?: string;
  assetIds: string[];
  generatedAssetJobIds: string[];
  variantCount: number;
}

export interface GenerationJobResult {
  timelineIds: string[];
}

export type GenerationJob = Job<GenerationJobInput, GenerationJobResult>;
