// PR2: provenance recorded on generated assets so agents can later inspect or
// reproduce exactly how an asset was produced.

import type {
  GeneratedAssetCharacterBinding,
  GenerationPreflightResult,
} from "@popcorn/shared/types";

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
  seed?: number;
  frameCount?: number;
  fps?: number;
  steps?: number;
  guidanceScale?: number;
  negativePrompt?: string;
  resolution?: string;
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
  // Per-beat provenance recorded by the beat-scoped media endpoints
  // (POST …/beats/:beatId/{keyframe,clip}). These are dependency edges in the
  // provenance graph (docs/scopes/north-star-provenance-graph.md): `beatId` ties
  // the asset to the plan beat it was generated for, and `anchorIds` to the
  // character/scene anchors that conditioned it — the basis for selective
  // regeneration. Absent for generic `generated-assets` calls.
  beatId?: string;
  anchorIds?: string[];
}
