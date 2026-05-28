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

export interface GenerateAssetRequest {
  provider: GenerativeProviderName;
  kind: GenerativeAssetKind;
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

export interface GeneratedAssetResult {
  kind: GenerativeAssetKind;
  bytes: Buffer;
  extension: string;
  mimeType: string;
  provider: GenerativeProviderName;
  model?: string;
  prompt: string;
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
