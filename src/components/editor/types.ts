import { DurationPolicy } from "@/lib/audio-alignment";

export interface CharacterFormState {
  name: string;
  description: string;
  identityInvariants: string;
  styleInvariants: string;
  wardrobeInvariants: string;
  negativePrompt: string;
}

export interface ExportAlignment {
  policy: DurationPolicy;
  exportDurationSec: number;
  truncatesAudio: boolean;
  warning?: string;
  comparison: {
    timelineDurationSec: number;
    audioDurationSec: number;
    deltaSec: number;
  };
}

export interface ExportResult {
  url: string;
  silentUrl?: string;
  overlayUrl?: string | null;
  audioUrls?: string[];
  alignment?: ExportAlignment;
}
