import type { AspectRatio } from "@popcorn/shared/types";

export const EDIT_GRAPH_SCHEMA_VERSION = "editGraph.v1" as const;
export const EDIT_GRAPH_PROJECT_SCHEMA_VERSION = "aiVideoProject.v1" as const;
export const EDIT_GRAPH_ASSET_SEMANTIC_ANALYSIS_SCHEMA_VERSION =
  "semanticAnalysis.v1" as const;
export const EDIT_GRAPH_EDIT_DECISION_SCHEMA_VERSION = "editDecision.v1" as const;

export type EditGraphSchemaVersion = typeof EDIT_GRAPH_SCHEMA_VERSION;
export type AIVideoProjectSchemaVersion =
  typeof EDIT_GRAPH_PROJECT_SCHEMA_VERSION;

export type MediaAssetType = "video" | "audio" | "image" | "text" | "generated";

export interface MediaAssetMetadata {
  width?: number;
  height?: number;
  fps?: number;
  sampleRate?: number;
  channels?: number;
  codec?: string;
}

export interface GeneratedMediaProvenance {
  provider: string;
  model?: string;
  prompt: string;
}

export interface MediaAsset {
  id: string;
  uri: string;
  type: MediaAssetType;
  durationMs?: number;
  metadata: MediaAssetMetadata;
  generatedBy?: GeneratedMediaProvenance;
}

export interface WordTiming {
  id: string;
  word: string;
  startMs: number;
  endMs: number;
  confidence: number;
}

export interface TranscriptSpan {
  id: string;
  assetId: string;
  startMs: number;
  endMs: number;
  speakerId?: string;
  text: string;
  words: WordTiming[];
}

export type TextEditOperationType =
  | "remove_words"
  | "compress_pause"
  | "reorder_sentence"
  | "bleep"
  | "caption_emphasis";

export type TextEditOperation =
  | {
      type: "remove_words";
      wordIds: string[];
      reason?: string;
    }
  | {
      type: "compress_pause";
      transcriptSpanIds: string[];
      targetPauseMs: number;
      reason?: string;
    }
  | {
      type: "reorder_sentence";
      transcriptSpanIds: string[];
      insertAfterSpanId?: string;
      reason?: string;
    }
  | {
      type: "bleep";
      wordIds: string[];
      reason?: string;
    }
  | {
      type: "caption_emphasis";
      wordIds: string[];
      style?: "highlight" | "underline" | "bold";
      reason?: string;
    };

export type SceneType =
  | "talking_head"
  | "b_roll"
  | "screen_recording"
  | "product_shot"
  | "title_card";

export interface AudioFeatures {
  energy: number;
  silence: boolean;
  music?: boolean;
  speech?: boolean;
}

export interface QualitySignals {
  sharpness?: number;
  exposure?: number;
  audioClarity?: number;
  faceVisible?: boolean;
  cameraMotion?: "static" | "smooth" | "shaky";
}
export interface MediaSegment {
  id: string;
  assetId: string;
  startMs: number;
  endMs: number;
  transcriptSpanIds?: string[];
  transcript?: TranscriptSpan[];
  visualDescription?: string;
  detectedObjects?: string[];
  sceneType?: SceneType;
  audioFeatures?: AudioFeatures;
  qualitySignals?: QualitySignals;
  semanticTags: string[];
}

export type StoryTone =
  | "educational"
  | "funny"
  | "cinematic"
  | "salesy"
  | "documentary";

export type StoryBeatRole =
  | "hook"
  | "context"
  | "problem"
  | "setup"
  | "demo"
  | "evidence"
  | "contrast"
  | "payoff"
  | "cta"
  | "outro";

export interface StoryBeatRequiredContent {
  transcriptMeaning?: string;
  visualTags?: string[];
  speaker?: string;
}

export interface StoryBeatEmotionalShape {
  energy: "low" | "medium" | "high";
  sentiment: "neutral" | "positive" | "tense" | "excited";
}

export interface StoryBeat {
  id: string;
  role: StoryBeatRole;
  intent: string;
  targetDurationMs?: number;
  requiredContent?: StoryBeatRequiredContent;
  emotionalShape?: StoryBeatEmotionalShape;
}

export interface StoryPlan {
  id: string;
  objective: string;
  targetDurationMs: number;
  audience?: string;
  tone?: StoryTone;
  beats: StoryBeat[];
}

export type EditOperation =
  | "select_segment"
  | "trim"
  | "cut"
  | "insert_broll"
  | "overlay"
  | "transition"
  | "caption"
  | "music"
  | "sound_effect"
  | "effect"
  | "remove_silence";

export interface EditDecisionConstraints {
  minDurationMs?: number;
  maxDurationMs?: number;
  mustIncludeWords?: string[];
  avoidJumpCut?: boolean;
  preserveSpeakerContinuity?: boolean;
}

export interface EditDecision {
  id: string;
  schemaVersion?: typeof EDIT_GRAPH_EDIT_DECISION_SCHEMA_VERSION;
  beatId: string;
  operation: EditOperation;
  sourceSegmentIds: string[];
  rationale?: string;
  constraints?: EditDecisionConstraints;
  textEdit?: TextEditOperation;
  confidence?: number;
}

export type TransitionType =
  | "hard_cut"
  | "jump_cut"
  | "match_cut"
  | "crossfade"
  | "audio_lead_in"
  | "audio_trail_out"
  | "smash_cut"
  | "scene_change"
  | "hidden_cut";

export type TransitionReason =
  | "sentence_boundary"
  | "beat_change"
  | "visual_match"
  | "music_downbeat"
  | "motion_continuity"
  | "emotional_shift"
  | "remove_dead_air"
  | "hide_jump_cut";

export interface TransitionTiming {
  cutAtMs: number;
  preRollMs?: number;
  postRollMs?: number;
}

export interface TransitionAlternative {
  type: TransitionType;
  cutAtMs: number;
  score: number;
}

export interface TransitionDecision {
  id: string;
  fromBeatId: string;
  toBeatId: string;
  type: TransitionType;
  timing: TransitionTiming;
  reason: TransitionReason;
  confidence: number;
  alternatives?: TransitionAlternative[];
}

export interface CandidateCutFeatures {
  sentenceBoundary: boolean;
  silenceBeforeMs: number;
  silenceAfterMs: number;
  visualMotionContinuity: number;
  musicBeatAlignment: number;
  facePoseChange: number;
  semanticShift: number;
}

export interface CandidateCut {
  atMs: number;
  score: number;
  features: CandidateCutFeatures;
}

export interface EditPolicy {
  pacing: "fast" | "balanced" | "slow";
  transitionStyle: "invisible" | "energetic" | "cinematic";
  tolerateJumpCuts: boolean;
  preferMusicSync: boolean;
}

export type OverlayRole =
  | "caption"
  | "lower_third"
  | "logo"
  | "callout"
  | "highlight"
  | "annotation"
  | "diagram"
  | "subtitle"
  | "reaction"
  | "comparison";

export type OverlayAnchor =
  | { type: "timeline_time"; refId?: string; offsetMs?: number }
  | { type: "spoken_phrase"; refId?: string; phrase: string; offsetMs?: number }
  | { type: "object"; refId?: string; offsetMs?: number }
  | { type: "person"; refId?: string; offsetMs?: number }
  | { type: "beat"; refId: string; offsetMs?: number };

export interface OverlayLayout {
  region: "top" | "bottom" | "left" | "right" | "center" | "custom";
  avoidFaces?: boolean;
  avoidSubtitles?: boolean;
  safeArea?: boolean;
}

export type OverlayContent =
  | { type: "text"; text: string }
  | { type: "image"; assetId: string }
  | { type: "shape"; shape: string }
  | { type: "generated"; prompt: string };

export interface StyleRef {
  id: string;
  name?: string;
}

export interface Overlay {
  id: string;
  role: OverlayRole;
  intent: string;
  anchor: OverlayAnchor;
  layout: OverlayLayout;
  content: OverlayContent;
  style?: StyleRef;
}

export interface EffectInstance {
  id: string;
  type: string;
  parameters?: Record<string, unknown>;
}

export interface TimelineTransform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
}

export type TimelineItemSource =
  | {
      kind: "media";
      assetId: string;
      sourceStartMs: number;
      sourceEndMs: number;
    }
  | { kind: "generated_text"; text: string }
  | { kind: "generated_image"; assetId: string }
  | { kind: "effect" };

export interface TimelineItem {
  id: string;
  source: TimelineItemSource;
  timelineStartMs: number;
  timelineEndMs: number;
  transform?: TimelineTransform;
  effects?: EffectInstance[];
}

export type TrackType = "video" | "audio" | "text" | "effect";
export type TrackRole =
  | "primary_video"
  | "b_roll"
  | "voiceover"
  | "music"
  | "captions"
  | "graphics"
  | "sfx";

export interface EditGraphTrack {
  id: string;
  type: TrackType;
  role: TrackRole;
  zIndex?: number;
  items: TimelineItem[];
}

export interface EditGraphTimeline {
  id: string;
  fps: number;
  width: number;
  height: number;
  durationMs: number;
  tracks: EditGraphTrack[];
}

export type RenderEngine = "ffmpeg" | "remotion" | "moviepy" | "custom_gpu";
export type RenderFormat = "mp4" | "mov" | "webm";
export type RenderCodec = "h264" | "h265" | "prores";

export interface RenderOutput {
  format: RenderFormat;
  codec: RenderCodec;
  width: number;
  height: number;
  fps: number;
  bitrate?: string;
}

export interface RenderPlan {
  engine: RenderEngine;
  output: RenderOutput;
}

export type CreativeBriefPlatform =
  | "youtube"
  | "tiktok"
  | "instagram"
  | "x"
  | "linkedin"
  | "internal";

export interface CreativeBrief {
  goal: string;
  audience?: string;
  platform?: CreativeBriefPlatform;
  targetDurationMs?: number;
  aspectRatio?: AspectRatio | "4:5";
  tone?: string;
  styleRefs?: string[];
}

export interface VisualEntity {
  id: string;
  assetId: string;
  segmentId?: string;
  label: string;
  confidence?: number;
  startMs?: number;
  endMs?: number;
}

export interface AudioEvent {
  id: string;
  assetId: string;
  segmentId?: string;
  type: "speech" | "silence" | "music" | "sfx" | "noise";
  startMs: number;
  endMs: number;
  confidence?: number;
}

export interface EmbeddingRef {
  id: string;
  ownerId: string;
  ownerType: "asset" | "segment" | "transcript_span" | "beat";
  model: string;
  vectorRef: string;
}

export interface AssetSemanticAnalysis {
  schemaVersion: typeof EDIT_GRAPH_ASSET_SEMANTIC_ANALYSIS_SCHEMA_VERSION;
  assetId: string;
  transcript: TranscriptSpan[];
  segments: MediaSegment[];
  createdAt: string;
}

export interface SemanticAnalysis {
  segments: MediaSegment[];
  transcript: TranscriptSpan[];
  visualEntities: VisualEntity[];
  audioEvents: AudioEvent[];
  embeddings: EmbeddingRef[];
}

export interface EditConstraints {
  maxDurationMs?: number;
  minDurationMs?: number;
  requiredBeats?: string[];
  forbiddenContent?: string[];
  preserveChronology?: boolean;
  allowGeneratedMedia?: boolean;
  allowVoiceover?: boolean;
  allowMusic?: boolean;
}

export interface EditGraph {
  schemaVersion: EditGraphSchemaVersion;
  decisions: EditDecision[];
  transitions: TransitionDecision[];
  overlays: Overlay[];
  constraints: EditConstraints;
  policy?: EditPolicy;
  candidateCuts?: CandidateCut[];
}

export interface AIVideoProject {
  schemaVersion: AIVideoProjectSchemaVersion;
  id: string;
  assets: MediaAsset[];
  analysis: SemanticAnalysis;
  intent: CreativeBrief;
  story: StoryPlan;
  edit: EditGraph;
  timeline: EditGraphTimeline;
  render: RenderPlan;
}
