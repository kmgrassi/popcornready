// PR2: provenance recorded on generated assets so agents can later inspect or
// reproduce exactly how an asset was produced.

import type {
  GeneratedAssetCharacterBinding,
  GenerationPreflightResult,
} from "@/lib/types";

export interface GeneratedAssetProviderSettings {
  model?: string;
  size?: string;
  quality?: string;
  seconds?: number;
  audioMode?: string;
  voiceId?: string;
  outputFormat?: string;
  languageCode?: string;
  loop?: boolean;
  promptInfluence?: number;
  forceInstrumental?: boolean;
  // Provider-returned consistency/reference settings, when present.
  consistency?: Record<string, unknown>;
}

export interface GeneratedAssetProvenance {
  provider: string;
  model?: string;
  prompt: string;
  providerPrompt?: string;
  preflight?: GenerationPreflightResult;
  referenceAssetIds?: string[];
  characterBinding?: GeneratedAssetCharacterBinding;
  providerSettings?: GeneratedAssetProviderSettings;
  requestedDurationSec?: number;
  actualDurationSec?: number;
}
