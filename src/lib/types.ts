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
  status: "draft" | "ready" | "archived";
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
  identity: "pass" | "needs_review" | "fail";
  wardrobe: "pass" | "needs_review" | "fail";
  style: "pass" | "needs_review" | "fail";
  temporal?: "pass" | "needs_review" | "fail";
  notes?: string;
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
}

export interface Clip {
  id: string;
  filename: string;
  url: string; // served path, e.g. /uploads/abc.mp4
  kind?: "video" | "image" | "audio";
  durationSec: number;
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
  };
}

export interface Beat {
  name: string; // e.g. "hook", "problem", "solution", "proof", "cta"
  durationSec: number;
  intent: string;
}

export interface EditPlan {
  targetLengthSec: number;
  style: string;
  aspectRatio: AspectRatio;
  beats: Beat[];
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
  role: string; // which beat this serves
  reason: string;
  caption?: string;
}

export interface Timeline {
  aspectRatio: AspectRatio;
  fps: number;
  segments: TimelineSegment[];
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

export interface Project {
  id: string;
  goal: string;
  storyContext?: StoryContext;
  plan: EditPlan | null;
  timeline: Timeline | null;
  clips: Clip[];
  critic: CriticReport | null;
  chat: ChatMessage[];
  characterProfiles?: CharacterProfile[];
  characterReferences?: CharacterReference[];
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
