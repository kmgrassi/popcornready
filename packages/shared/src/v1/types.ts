// Shared /api/v1 contract types.
//
// These describe the resources the versioned agent API operates on. Most of
// these entities (projects, brief versions, assets, compositions) are created
// and owned by the PR1-PR3 foundation; PR4 (timeline generation) only reads
// them and writes Jobs + VersionedTimelines. They live here as the agreed
// contract so every PR builds against the same shapes.

import {
  CompiledTimelineMetadata,
  EDIT_GRAPH_SCHEMA_VERSION,
  EditGraphDocument,
} from "../edit-graph";
import { AspectRatio, CriticReport, EditPlan, StoryContext, TimelineSegment } from "../types";

export type { AspectRatio } from "../types";

export const SCHEMA = {
  project: "project.v1",
  briefVersion: "brief.v1",
  asset: "asset.v1",
  composition: "composition.v1",
  editGraph: EDIT_GRAPH_SCHEMA_VERSION,
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
  // The project's editable storyboard plan (Scenes -> Beats). Null until a plan
  // exists. Edited via PUT /projects/:id/plan (Storyboard & Scenes — PR6).
  plan?: EditPlan | null;
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
export type AssetMediaType = AssetKind | "text" | "reference";
export type AssetOrigin = "uploaded" | "generated" | "imported" | "derived";
export type AssetUse =
  | "primary_footage"
  | "b_roll"
  | "character_reference"
  | "style_reference"
  | "location_reference"
  | "logo_or_brand"
  | "music"
  | "voiceover"
  | "dialogue"
  | "sound_effect"
  | "title_or_graphic";
export type KnowledgeConfidence = "low" | "medium" | "high";
export type KnowledgeAction =
  | "ask_user"
  | "sample_video"
  | "analyze_image"
  | "transcribe_audio";

export interface UserAssetContext {
  title?: string;
  description?: string;
  people?: string[];
  characterNames?: string[];
  location?: string;
  event?: string;
  notableMoments?: string[];
  tags?: string[];
  transcriptHint?: string;
  audioNotes?: string;
  intendedUse?: AssetUse[];
  mustUse?: boolean;
  avoid?: boolean;
}

export type UserClipContext = UserAssetContext;

export interface UsableMoment {
  startSec: number;
  endSec: number;
  label: string;
  description: string;
  suggestedUse:
    | "hook"
    | "context"
    | "proof"
    | "emotion"
    | "transition"
    | "detail"
    | "b_roll"
    | "cta";
}

export interface AgentAssetContext {
  summary: string;
  mediaType: AssetMediaType;
  subjects: string[];
  actions?: string[];
  setting?: string;
  mood?: string;
  likelyUses: AssetUse[];
  cautions: string[];
  transcriptSummary?: string;
  confidence: KnowledgeConfidence;
  sampledAssetIds: string[];
  model: {
    provider: string;
    model?: string;
  };
}

export interface AgentClipContext extends AgentAssetContext {
  mediaType: "video";
  visualSubjects: string[];
  shotTypes: string[];
  usableMoments: UsableMoment[];
  sampledFrames: string[];
}

export interface KnowledgeGap {
  field: string;
  question: string;
  canInferAutomatically: boolean;
  suggestedAction: KnowledgeAction;
}

export interface KnownFact {
  field: string;
  value: string;
  confidence: KnowledgeConfidence;
  source: "user" | "agent" | "generation_prompt" | "metadata" | "transcript";
}

export interface AssetConstraint {
  type:
    | "must_use"
    | "avoid"
    | "likeness_reference"
    | "style_reference"
    | "brand_required"
    | "audio_required"
    | "no_audio"
    | "do_not_crop"
    | "do_not_modify";
  reason?: string;
}

export interface AssetRelationship {
  type:
    | "derived_from"
    | "sampled_from"
    | "represents_character"
    | "represents_location"
    | "belongs_to_scene"
    | "audio_for"
    | "visual_for";
  targetAssetId: string;
  description?: string;
}

export interface AssetKnowledge {
  assetId: string;
  mediaType: AssetMediaType;
  origin: AssetOrigin;
  userContext?: UserAssetContext;
  agentContext?: AgentAssetContext | AgentClipContext;
  knowledgeScore: number;
  knowledgeSummary: string;
  knownFacts: KnownFact[];
  unknowns: KnowledgeGap[];
  likelyUses: AssetUse[];
  constraints: AssetConstraint[];
  relationships: AssetRelationship[];
  provenance: {
    createdAt: string;
    updatedAt: string;
    analysisVersion: string;
    model?: {
      provider: string;
      model?: string;
    };
    sourcePrompt?: string;
    sampledAssetIds: string[];
    transcriptAssetId?: string;
  };
}

export interface ClipUnderstanding {
  assetId: string;
  source: "upload" | "generated";
  userContext?: UserClipContext;
  agentContext?: AgentClipContext | AgentAssetContext;
  combinedSummary: string;
  timelineHints: {
    mustUse: boolean;
    avoid: boolean;
    preferredBeats: string[];
    bestStartSec?: number;
    bestEndSec?: number;
  };
  provenance: {
    userContextUpdatedAt?: string;
    analyzedAt?: string;
    analysisVersion: string;
    sampledFrameAssetIds: string[];
  };
}

export interface AssetKnowledgeSummary {
  assetId: string;
  mediaType: AssetMediaType;
  known: string[];
  unknown: KnowledgeGap[];
  likelyUses: AssetUse[];
  confidence: KnowledgeConfidence;
}

export interface AssetInventoryReport {
  projectId: string;
  assets: AssetKnowledgeSummary[];
  globalKnowns: string[];
  globalUnknowns: KnowledgeGap[];
  recommendedLearningActions: {
    assetId?: string;
    action: KnowledgeAction;
    reason: string;
  }[];
  coverageEstimate: {
    video: "none" | "partial" | "complete";
    images: "none" | "partial" | "complete";
    audio: "none" | "partial" | "complete";
    characters: "none" | "partial" | "complete";
    brandsOrLogos: "none" | "partial" | "complete";
  };
}

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
  userContext?: UserAssetContext;
  agentContext?: AgentAssetContext | AgentClipContext;
  assetKnowledge?: AssetKnowledge;
  clipUnderstanding?: ClipUnderstanding;
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
  // Wall-clock time the current step started. Used by operator diagnostics to
  // identify slow stages without a separate metrics pipeline.
  stepStartedAt?: string;
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
  // Correlation ID of the HTTP request that created the job. Logged on every
  // lifecycle event so a slow or failed job can be traced back to its request.
  requestId?: string;
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
  showCaptions?: boolean;
  segments: TimelineSegment[];
  provenance: TimelineProvenance;
  derivedFrom?: CompiledTimelineMetadata;
  createdBy: { jobId: string };
  createdAt: string;
}

export type VersionedEditGraph = EditGraphDocument;

// --- Generation request/result --------------------------------------------

export interface GenerationRequest {
  briefVersionId?: string;
  assetIds?: string[];
  compositionId?: string;
  mode?: CompositionMode;
  allowGeneratedGapFill?: boolean;
  variantCount?: number;
  audioAlignment?: {
    mode: string;
    audioAssetId?: string;
  };
  showCaptions?: boolean;
}

// Validated, resolved inputs the executor runs against. Stored on the job so
// execution does not re-validate or re-resolve.
export interface GenerationJobInput {
  briefVersionId: string;
  compositionId?: string;
  mode?: CompositionMode;
  allowGeneratedGapFill?: boolean;
  assetIds: string[];
  generatedAssetJobIds: string[];
  variantCount: number;
  showCaptions?: boolean;
}

export interface GenerationJobResult {
  timelineIds: string[];
  editGraphIds?: string[];
}

export type GenerationJob = Job<GenerationJobInput, GenerationJobResult>;


// --- Generation Runs (Progress UI) -----------------------------------------
//
// A GenerationRun is the run-level aggregate the progress UI renders against:
// one end-to-end video-generation attempt expressed as a sequence of stages.
//
// Run state maps onto existing job state — it does NOT introduce a second
// status vocabulary:
//   - GenerationRunStatus IS JobStatus. The same queued/running/succeeded/
//     failed/canceled states stay the source of truth. A run's status is
//     derived from the states of the jobs it aggregates:
//       * queued    - no underlying job has started running yet.
//       * running   - at least one underlying job is running.
//       * failed    - a non-retryable job failed and blocks the run.
//       * canceled  - the run (and its active jobs) were canceled.
//       * succeeded - the export job succeeded and the video is ready.
//   - GenerationStage and GenerationStageItem reuse the same status union.
//   - Per-job JobProgress (currentStep/percent/message) rolls up into the
//     run-level currentStageType/progressPercent/message and the matching
//     stage's progressPercent/message.
//   - jobIds and artifactIds point back to the authoritative Job and Artifact
//     records; the run never duplicates their state.
//   - Review checkpoints are represented by reviewGate, not by adding an
//     "awaiting_review" status. A paused run remains an active JobStatus
//     while execution is idle and waiting for approval.

export type GenerationRunStatus = JobStatus;

// Ordered stage types a run can move through. Individual runs may skip stages
// they do not need (e.g. a prompt-only run with no uploaded assets).
export type GenerationStageType =
  | "brief_intake"
  | "creative_plan"
  | "asset_generation"
  | "audio_generation"
  | "timeline_assembly"
  | "quality_review"
  | "export"
  | "ready";

// The user's per-run choice of which stages should pause for review after they
// complete. An empty or omitted list is a straight-through run.
export const GATEABLE_GENERATION_STAGE_TYPES = [
  "brief_intake",
  "creative_plan",
  "asset_generation",
  "audio_generation",
  "timeline_assembly",
  "quality_review",
  "export",
] as const satisfies readonly GenerationStageType[];

export type GateableGenerationStageType =
  (typeof GATEABLE_GENERATION_STAGE_TYPES)[number];

export interface ReviewGateConfig {
  gatedStages: GateableGenerationStageType[];
}

// Run-level review state, orthogonal to GenerationRunStatus. When present, the
// run is awaiting user approval before the next stage can start.
export interface RunReviewGate {
  stageType: GateableGenerationStageType;
  stageId: string;
  state: "awaiting_review";
  enteredAt: string;
}

// User-safe error summary for a failed run, stage, or stage item. `code` and
// `message` mirror JobError; `retryable` and the redacted, diagnostic-safe
// `details` carry the extras the progress UI needs to offer recovery.
export interface GenerationErrorSummary {
  code: string;
  message: string;
  // Keep optional so existing fixture/demo payloads can omit non-essential metadata.
  retryable?: boolean;
  // Optional diagnostic detail suitable for UI copy or troubleshooting surfaces.
  details?: string;
}

export type GenerationJudgmentVerdict = "pass" | "needs_review" | "fail";

export interface GenerationJudgmentSummary {
  judgmentId: string;
  evaluatorId: string;
  verdict: GenerationJudgmentVerdict;
  rationale: string;
  recommendedAction?: "keep" | "regenerate" | "manual_review";
  grades?: Record<string, number | "pass" | "needs_review" | "fail">;
  evidenceRef?: string;
  createdAt: string;
}

export interface GenerationRun {
  runId: string;
  projectId: string;
  briefVersionId?: string;
  status: GenerationRunStatus;
  reviewGates?: GateableGenerationStageType[];
  reviewGate?: RunReviewGate | null;
  currentStageType?: GenerationStageType;
  progressPercent?: number;
  message?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: GenerationErrorSummary;
  judgment?: GenerationJudgmentSummary;
}

export interface GenerationStage {
  stageId: string;
  runId: string;
  type: GenerationStageType;
  label: string;
  order: number;
  status: GenerationRunStatus;
  isReviewGate?: boolean;
  reviewedAt?: string | null;
  progressPercent?: number;
  message?: string;
  startedAt?: string;
  completedAt?: string;
  jobIds: string[];
  artifactIds: string[];
  createdAt: string;
  updatedAt: string;
  error?: GenerationErrorSummary;
  judgment?: GenerationJudgmentSummary;
}

// Child item of an asset-heavy stage so the UI can show per-beat cards.
export type GenerationStageItemKind =
  | "image"
  | "video"
  | "audio"
  | "caption"
  | "timeline"
  | "export";

export interface GenerationStageItem {
  itemId: string;
  stageId: string;
  kind: GenerationStageItemKind;
  label: string;
  status: GenerationRunStatus;
  progressPercent?: number;
  provider?: string;
  promptPreview?: string;
  assetId?: string;
  artifactId?: string;
  retryable?: boolean;
  createdAt: string;
  updatedAt: string;
  error?: GenerationErrorSummary;
  judgment?: GenerationJudgmentSummary;
}

// Canonical order and default labels for the stage rail. Individual runs may
// skip stages they do not need; the rail orders whatever it is given by this
// position.
export const GENERATION_STAGE_ORDER: Record<GenerationStageType, number> = {
  brief_intake: 0,
  creative_plan: 1,
  asset_generation: 2,
  audio_generation: 3,
  timeline_assembly: 4,
  quality_review: 5,
  export: 6,
  ready: 7,
};

export const GENERATION_STAGE_LABELS: Record<GenerationStageType, string> = {
  brief_intake: "Brief",
  creative_plan: "Plan",
  asset_generation: "Visuals",
  audio_generation: "Audio",
  timeline_assembly: "Timeline",
  quality_review: "Review",
  export: "Render",
  ready: "Ready",
};
