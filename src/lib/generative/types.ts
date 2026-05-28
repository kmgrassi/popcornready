export type GenerativeProviderName =
  | "openai"
  | "gemini"
  | "nanobanano"
  | "mock";

export type GenerativeAssetKind = "image" | "video";

export interface GenerateAssetRequest {
  provider: GenerativeProviderName;
  kind: GenerativeAssetKind;
  prompt: string;
  referencePaths?: string[];
  model?: string;
  size?: string;
  quality?: "low" | "medium" | "high" | "auto";
  seconds?: number;
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
