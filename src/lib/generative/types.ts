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

export interface GenerateAssetRequest {
  provider: GenerativeProviderName;
  kind: GenerativeAssetKind;
  prompt: string;
  referencePaths?: string[];
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
}

export interface GenerativeProvider {
  name: GenerativeProviderName;
  generateAsset(input: GenerateAssetRequest): Promise<GeneratedAssetResult>;
}
