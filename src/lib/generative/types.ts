import type {
  CharacterConsistencyMode,
  CharacterProfile,
  CharacterReference,
} from "@/lib/types";

export type GenerativeProviderName =
  | "openai"
  | "gemini"
  | "elevenlabs"
  | "nanobanano"
  | "mock";

export type GenerativeAssetKind = "image" | "video" | "audio";
export type AudioGenerationMode = "speech" | "dialogue" | "sound_effect" | "music";

export type OpenAIImageModel =
  | "gpt-image-1"
  | "gpt-image-1.5"
  | "gpt-image-1-mini"
  | "dall-e-2"
  | "dall-e-3";

export type OpenAIVideoModel =
  | "sora-2"
  | "sora-2-pro"
  | "sora-2-2025-10-06"
  | "sora-2-pro-2025-10-06"
  | "sora-2-2025-12-08";

export const OPENAI_IMAGE_SIZES = ["1024x1024", "1024x1536", "1536x1024"] as const;
export const OPENAI_VIDEO_SIZES = [
  "720x1280",
  "1280x720",
  "1024x1792",
  "1792x1024",
] as const;

export const OPENAI_VIDEO_SECONDS = [4, 8, 12] as const;

export type OpenAIImageSize = (typeof OPENAI_IMAGE_SIZES)[number];
export type OpenAIVideoSize = (typeof OPENAI_VIDEO_SIZES)[number];
export type OpenAIVideoSeconds = (typeof OPENAI_VIDEO_SECONDS)[number];

export function normalizeOpenAIImageSize(
  value?: string,
  fallback: OpenAIImageSize = "1024x1024"
): OpenAIImageSize {
  if (!value) return fallback;
  const trimmed = value.trim();
  return (OPENAI_IMAGE_SIZES as readonly string[]).includes(trimmed)
    ? (trimmed as OpenAIImageSize)
    : fallback;
}

export function normalizeOpenAIVideoSize(
  value: string | undefined,
  fallback: OpenAIVideoSize = "1280x720"
): OpenAIVideoSize {
  if (!value) return fallback;
  const trimmed = value.trim();
  return (OPENAI_VIDEO_SIZES as readonly string[]).includes(trimmed)
    ? (trimmed as OpenAIVideoSize)
    : fallback;
}

export function normalizeOpenAIVideoSeconds(
  value: number | undefined,
  fallback: OpenAIVideoSeconds = 8
): OpenAIVideoSeconds {
  const candidate = Math.round(Number(value));
  if (!Number.isFinite(candidate)) return fallback;

  if (candidate <= 6) return 4;
  if (candidate <= 10) return 8;
  return 12;
}

export interface DialogueInput {
  text: string;
  voiceId: string;
}

export interface ShotDelta {
  action?: string;
  camera?: string;
  setting?: string;
  emotion?: string;
  prompt?: string;
}

export interface CharacterReferenceInput {
  reference: CharacterReference;
  assetId: string;
  path: string;
  url: string;
}

export interface CharacterGenerationContext {
  profiles: CharacterProfile[];
  references: CharacterReferenceInput[];
  consistencyMode: CharacterConsistencyMode;
  promptInvariantVersion: string;
  originalPrompt: string;
  shotDelta?: ShotDelta;
}

interface BaseGenerateAssetRequest {
  prompt: string;
  referencePaths?: string[];
  characterContext?: CharacterGenerationContext;
  model?: string;
  size?: string;
  quality?: "low" | "medium" | "high" | "auto";
  seconds?: number;
  audioMode?: AudioGenerationMode;
  voiceId?: string;
  outputFormat?: string;
  languageCode?: string;
  dialogueInputs?: DialogueInput[];
  loop?: boolean;
  promptInfluence?: number;
  forceInstrumental?: boolean;
}

export interface OpenAIImageRequest extends BaseGenerateAssetRequest {
  provider: "openai";
  kind: "image";
  model?: OpenAIImageModel | string;
  size?: string;
}

export interface OpenAIVideoRequest extends BaseGenerateAssetRequest {
  provider: "openai";
  kind: "video";
  model?: OpenAIVideoModel | string;
  size?: string;
  seconds?: number;
}

export interface GeminiVideoRequest extends BaseGenerateAssetRequest {
  provider: "gemini";
  kind: "video";
  model?: string;
  size?: string;
  seconds?: number;
}

export interface MockImageRequest extends BaseGenerateAssetRequest {
  provider: "mock";
  kind: "image";
  model?: string;
  size?: string;
  quality?: "low" | "medium" | "high" | "auto";
}

export interface NanoBananoImageRequest extends BaseGenerateAssetRequest {
  provider: "nanobanano";
  kind: "image";
  model?: string;
  size?: string;
}

export interface ElevenLabsAudioRequest extends BaseGenerateAssetRequest {
  provider: "elevenlabs";
  kind: "audio";
  model?: string;
  seconds?: number;
  audioMode?: AudioGenerationMode;
  voiceId?: string;
  outputFormat?: string;
  languageCode?: string;
  dialogueInputs?: DialogueInput[];
  loop?: boolean;
  promptInfluence?: number;
  forceInstrumental?: boolean;
}

export type GenerateAssetRequest =
  | OpenAIImageRequest
  | OpenAIVideoRequest
  | GeminiVideoRequest
  | MockImageRequest
  | NanoBananoImageRequest
  | ElevenLabsAudioRequest;

export interface GeneratedAssetResult {
  kind: GenerativeAssetKind;
  bytes: Buffer;
  extension: string;
  mimeType: string;
  provider: GenerativeProviderName;
  model?: string;
  prompt: string;
  durationSec?: number;
  providerSettings?: {
    references: string[];
    mode: CharacterConsistencyMode;
    seed?: number;
    durationSec?: number;
    aspectRatio?: string;
    promptInvariantVersion: string;
  };
}

export interface GenerativeProvider {
  name: GenerativeProviderName;
  generateAsset(input: GenerateAssetRequest): Promise<GeneratedAssetResult>;
}
