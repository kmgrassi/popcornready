import {
  CharacterConsistencyGrade,
  CharacterReferenceQuality,
  CharacterReferenceRole,
} from "@/lib/types";
import { DurationPolicy } from "@/lib/audio-alignment";

export const DEFAULT_IMAGE_SIZE = "1024x1536";
export const DEFAULT_VIDEO_SIZE = "720x1280";

export const CHARACTER_REFERENCE_ROLES: CharacterReferenceRole[] = [
  "front_portrait",
  "three_quarter",
  "profile",
  "full_body",
  "style",
  "wardrobe",
  "hero_frame",
];

export const CHARACTER_REFERENCE_QUALITIES: CharacterReferenceQuality[] = [
  "candidate",
  "approved",
  "rejected",
];

export const REVIEW_STATUSES: CharacterConsistencyGrade[] = [
  "needs_review",
  "pass",
  "fail",
];

export interface CharacterFormState {
  name: string;
  description: string;
  identityInvariants: string;
  styleInvariants: string;
  wardrobeInvariants: string;
  negativePrompt: string;
}

export function titleize(value: string): string {
  return value.replace(/_/g, " ");
}

export function emptyCharacterForm(): CharacterFormState {
  return {
    name: "",
    description: "",
    identityInvariants: "",
    styleInvariants: "",
    wardrobeInvariants: "",
    negativePrompt: "",
  };
}

export function defaultConsistencyModeForKind(kind: "image" | "video") {
  return kind === "video" ? "hero_frame" : "reference_pack";
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

export interface CreatedVideo {
  id: string;
  url: string;
  filename: string;
  createdAt: string;
  sizeBytes: number;
  durationSec?: number;
  hasAudioOverlay: boolean;
  silentUrl?: string;
  overlayUrl?: string;
}

export const DURATION_POLICY_LABELS: Record<DurationPolicy, string> = {
  timeline_only: "Timeline only (may cut audio)",
  match_longest_media: "Match longest media (keep audio whole)",
  fail_on_mismatch: "Fail on mismatch (require alignment)",
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatCreatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
