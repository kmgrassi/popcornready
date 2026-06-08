import type { EditGraph } from "./edit-graph";
import type { Asset, AssetSelection } from "./assets/types";

// Core domain types. The whole product revolves around the Timeline — the AI
// never touches raw video, it only edits this structured representation.

export type AspectRatio = "9:16" | "16:9" | "1:1";

export type CharacterReferenceRole =
  | "front_portrait"
  | "three_quarter"
  | "profile"
  | "full_body"
  | "style"
  | "wardrobe"
  | "hero_frame";

export type CharacterReferenceQuality = "candidate" | "approved" | "rejected";
export type CharacterProfileStatus = "draft" | "ready" | "archived";
export type CharacterConsistencyGrade = "pass" | "needs_review" | "fail";

export type CharacterConsistencyMode =
  | "prompt_only"
  | "reference_pack"
  | "hero_frame"
  | "first_frame_video"
  | "fine_tuned";

export interface CharacterProfile {
  id: string;
  projectId: string;
  name: string;
  description: string;
  identityInvariants: string;
  styleInvariants?: string;
  wardrobeInvariants?: string;
  negativePrompt?: string;
  status: CharacterProfileStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CharacterReference {
  id: string;
  characterProfileId: string;
  assetId: string;
  role: CharacterReferenceRole;
  quality: CharacterReferenceQuality;
  notes?: string;
}

export interface CharacterConsistencyReview {
  identity: CharacterConsistencyGrade;
  wardrobe: CharacterConsistencyGrade;
  style: CharacterConsistencyGrade;
  temporal?: CharacterConsistencyGrade;
  notes?: string;
}

export type ReviewGrade = "pass" | "needs_review" | "fail";

export interface PlanCritiqueIssue {
  severity: "low" | "medium" | "high";
  area:
    | "story_arc"
    | "beat_order"
    | "character_continuity"
    | "prompt_specificity"
    | "visual_feasibility"
    | "timing";
  issue: string;
  recommendation: string;
}

export interface PlanCritiqueReport {
  storyArc: ReviewGrade;
  characterContinuity: ReviewGrade;
  promptReadiness: ReviewGrade;
  visualFeasibility: ReviewGrade;
  summary: string;
  issues: PlanCritiqueIssue[];
  revisedPlan: EditPlan;
}

export type UploadedFootageEditMode = "asset_driven" | "hybrid";

export interface UploadedFootagePlanReview {
  storyArc: ReviewGrade;
  sourceCoverage: ReviewGrade;
  timing: ReviewGrade;
  missingBeats: string[];
  recommendedMode:
    | "uploaded_only"
    | "hybrid_generate_gaps"
    | "needs_more_source";
  summary: string;
  revisedPlan: EditPlan;
}

export interface VideoSnapshotReview {
  storyMatch: ReviewGrade;
  characterMatch: ReviewGrade;
  visualQuality: ReviewGrade;
  continuityNotes: string;
  recommendedAction: "keep" | "regenerate" | "manual_review";
  snapshots: string[];
  reviewer: {
    provider: string;
    model?: string;
  };
}

export interface GeneratedAssetCharacterBinding {
  assetId: string;
  characterProfileIds: string[];
  referenceIds: string[];
  consistencyMode: CharacterConsistencyMode;
  originalPrompt: string;
  promptInvariantVersion: string;
  providerSettings?: {
    provider: string;
    model?: string;
    references: string[];
    mode: CharacterConsistencyMode;
    seed?: number;
    durationSec?: number;
    aspectRatio?: string;
    promptInvariantVersion: string;
  };
  consistencyReview?: CharacterConsistencyReview;
  videoReview?: VideoSnapshotReview;
}

export interface Clip {
  id: string;
  filename: string;
  url: string; // served path, e.g. /uploads/abc.mp4
  kind?: "video" | "image" | "audio";
  durationSec: number;
  // For audio clips, the duration decoded from the actual media bytes (vs the
  // requested/estimated durationSec). Drives audio/timeline alignment.
  measuredDurationSec?: number;
  description: string; // user-provided hint the agent reasons over
  source?: "upload" | "generated";
  generatedBy?: {
    provider: string;
    model?: string;
    prompt: string;
    providerPrompt?: string;
    characterBinding?: GeneratedAssetCharacterBinding;
    originalPrompt?: string;
    preflight?: GenerationPreflightResult;
    costUsd?: number;
    // Recorded input edges into the asset pool (asset-pool PR D). Mirrors
    // AssetInputs in src/lib/assets/types.ts — e.g. the beat_keyframe asset a
    // clip grew from, so provenance names the keyframe instead of losing its
    // file path. Owned/extended by the provenance-graph lane.
    inputs?: {
      firstFrameAssetId?: string;
    };
    // Canonical hash of the stable request inputs this asset was generated for
    // (e.g. the soundtrack's goal/style/length). Drives reuse-vs-regenerate on
    // resume in place of brittle string/duration matching. Owned by the
    // provenance-graph lane (src/lib/provenance/fingerprint.ts).
    requestFingerprint?: string;
  };
  characterBinding?: GeneratedAssetCharacterBinding;
  videoReview?: VideoSnapshotReview;
}

export interface Beat {
  // Stable id minted at plan creation so assets/segments reference a beat by id
  // rather than its (non-unique, rename-fragile) `name`. Optional for backward
  // compatibility with plans persisted before stable ids existed.
  id?: string;
  name: string; // e.g. "hook", "problem", "solution", "proof", "cta"
  durationSec: number;
  intent: string;
}

// A Scene is the continuity tier above beats: a shared setting, cast, and look
// that its beats inherit. The storyboard is an ordered list of scenes, each
// containing ordered beats (≈ shots). See docs/scopes/storyboard-scenes.md.
export interface Scene {
  id: string; // stable, like Beat.id
  name: string; // "Setup", "The reveal", …
  setting?: string; // location / time / environment
  mood?: string; // lighting, tone
  characterIds?: string[]; // cast present in this scene
  anchorAssetId?: string; // the scene_anchor image (establishing look)
  beats: Beat[]; // ≈ shots; inherit the scene's setting/cast/look
}

export interface EditPlan {
  targetLengthSec: number;
  style: string;
  aspectRatio: AspectRatio;
  scenes: Scene[];
}

// Read-helper: flatten a plan's scenes into their ordered beats. Consumers that
// only care about the beat sequence (timeline, edit-graph, storyboard tiles)
// use this rather than reaching into `scene.beats` directly.
export function planBeats(plan: Pick<EditPlan, "scenes">): Beat[] {
  if (!plan.scenes) {
    const flat = (plan as { beats?: Beat[] }).beats;
    return Array.isArray(flat) ? flat : [];
  }
  return plan.scenes.flatMap((scene) => scene.beats ?? []);
}

// Wrap a flat list of beats in a single implicit scene. Use when constructing a
// plan from a flat beat list (e.g. short clips that don't need explicit scenes).
export function singleSceneFromBeats(beats: Beat[], name = "Scene 1"): Scene[] {
  return [{ id: "scene_1", name, beats }];
}

export interface StoryContext {
  audience?: string;
  platform?: "youtube" | "tiktok" | "reels" | "facebook" | "vimeo" | "general";
  format?:
    | "mystery_to_model"
    | "visual_reveal"
    | "challenge"
    | "misconception"
    | "animated_explainer"
    | "classroom_demo"
    | "aesthetic_montage";
  hookQuestion?: string;
  strongestVisual?: string;
  emotionalPull?: string;
  oneBigIdea?: string;
  simpleModel?: string;
  caveat?: string;
  payoff?: string;
  callToAction?: string;
}

export interface TimelineSegment {
  id: string;
  clipId: string;
  sourceInSec: number;
  sourceOutSec: number;
  role: string; // which beat this serves (display label)
  // Stable id of the beat this segment serves. Preferred over `role` for
  // beat↔segment linkage; `role` is kept for display and legacy fallback.
  beatId?: string;
  reason: string;
  caption?: string;
}

export interface Timeline {
  aspectRatio: AspectRatio;
  fps: number;
  segments: TimelineSegment[];
  // When true, captions generated on segments are rendered as on-screen overlays.
  showCaptions?: boolean;
}

export type RenderEngine = "remotion";
export type RenderOutputFormat = "mp4";
export type RenderVideoCodec = "h264";
export type RenderDurationPolicy =
  | "timeline_only"
  | "match_longest_media"
  | "fail_on_mismatch";

export interface RenderPlan {
  schemaVersion: "render-plan.v1";
  engine: RenderEngine;
  timelineId?: string;
  durationPolicy: RenderDurationPolicy;
  durationSec: number;
  timelineDurationSec: number;
  audioDurationSec: number;
  audioAssetIds: string[];
  output: {
    format: RenderOutputFormat;
    codec: RenderVideoCodec;
    width: number;
    height: number;
    fps: number;
    quality: string;
  };
}

export interface CriticScores {
  hook_score: number;
  clarity_score: number;
  pacing_score: number;
  visual_variety: number;
  script_coverage: number;
  emotional_arc: number;
  repetition_penalty: number;
}

export interface CriticReport {
  scores: CriticScores;
  summary: string;
}

export interface GenerationPreflightIssue {
  severity: "low" | "medium" | "high";
  area:
    | "story"
    | "clarity"
    | "accuracy"
    | "visual_feasibility"
    | "safety"
    | "provider_fit"
    | "asset_continuity";
  issue: string;
  recommendation: string;
}

export interface GenerationPreflightPass {
  iteration: number;
  summary: string;
  issues: GenerationPreflightIssue[];
  revisedPrompt: string;
  revisedDescription: string;
  revisedDialogueInputs?: { index: number; text: string }[];
}

export interface GenerationPreflightResult {
  requestedIterations: number;
  completedIterations: number;
  originalPrompt: string;
  finalPrompt: string;
  finalDescription: string;
  finalDialogueInputs?: { text: string; voiceId: string }[];
  passes: GenerationPreflightPass[];
}

export type Patch =
  | {
      op: "replace_clip";
      segmentId: string;
      newClipId: string;
      sourceInSec: number;
      sourceOutSec: number;
      reason: string;
    }
  | {
      op: "set_trim";
      segmentId: string;
      sourceInSec: number;
      sourceOutSec: number;
      reason: string;
    }
  | { op: "remove_segment"; segmentId: string; reason: string }
  | { op: "reorder"; segmentIdsInOrder: string[]; reason: string }
  | {
      op: "add_segment";
      clipId: string;
      sourceInSec: number;
      sourceOutSec: number;
      role: string;
      afterSegmentId: string | null;
      reason: string;
    }
  | { op: "set_caption"; segmentId: string; caption: string; reason: string };

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

// Composition planning (agent video generation API, PR3): turn a brief into an
// explicit per-beat plan of which assets to reuse and which to generate, plus
// the child asset-generation jobs needed before a timeline can be built.

export type CompositionMode = "asset_driven" | "prompt_only" | "hybrid";

export type CompositionAssetStrategy =
  | "use_existing"
  | "generate_image"
  | "generate_video";

export type AssetGenerationKind = "image" | "video" | "audio";

export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

export interface AssetGenerationJob {
  id: string;
  compositionId: string;
  projectId: string;
  beatName: string;
  kind: AssetGenerationKind;
  provider: string;
  prompt: string;
  status: JobStatus;
  resultAssetId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CompositionPlannedBeat {
  name: string;
  intent: string;
  durationSec: number;
  assetStrategy: CompositionAssetStrategy;
  requiredAssetIds?: string[];
  generatedAssetJobIds?: string[];
}

export interface CompositionNarrationStrategy {
  mode: "none" | "provided" | "generate";
  script?: string;
  audioAssetId?: string;
  estimatedDurationSec?: number;
  actualDurationSec?: number;
}

export type CompositionStatus =
  | "ready_for_timeline"
  | "needs_assets"
  | "failed";

export interface CompositionPlan {
  id: string;
  projectId: string;
  briefVersionId?: string;
  idempotencyKey?: string;
  mode: CompositionMode;
  plannedBeats: CompositionPlannedBeat[];
  narrationStrategy?: CompositionNarrationStrategy;
  generatedAssetJobIds: string[];
  status: CompositionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  goal: string;
  storyContext?: StoryContext;
  plan: EditPlan | null;
  editGraph?: EditGraph;
  timeline: Timeline | null;
  renderPlan?: RenderPlan | null;
  clips: Clip[];
  // Project-scoped pool of self-describing assets (keyframes, character anchors,
  // …) and the active-selection pointers into it. Additive for now: `clips[]`
  // remains the runtime/render shape; PR F converges them. See
  // docs/scopes/north-star-asset-pool.md.
  assets?: Asset[];
  selections?: AssetSelection[];
  characterProfiles?: CharacterProfile[];
  characterReferences?: CharacterReference[];
  compositions?: CompositionPlan[];
  assetGenerationJobs?: AssetGenerationJob[];
  preGenerationReview?: PlanCritiqueReport | null;
  uploadedFootageEdit?: {
    mode: UploadedFootageEditMode;
    selectedAssetIds: string[];
    allowGeneratedGapFill: boolean;
    planReview: UploadedFootagePlanReview;
    updatedAt: string;
  };
  critic: CriticReport | null;
  chat: ChatMessage[];
  updatedAt: string;
}

export function dims(ar: AspectRatio): { width: number; height: number } {
  switch (ar) {
    case "16:9":
      return { width: 1920, height: 1080 };
    case "1:1":
      return { width: 1080, height: 1080 };
    case "9:16":
    default:
      return { width: 1080, height: 1920 };
  }
}

export function segmentDurationSec(s: TimelineSegment): number {
  return Math.max(0, s.sourceOutSec - s.sourceInSec);
}

export function timelineDurationSec(t: Timeline | null): number {
  if (!t) return 0;
  return t.segments.reduce((sum, s) => sum + segmentDurationSec(s), 0);
}
