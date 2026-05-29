import {
  CharacterConsistencyGrade,
  CharacterReferenceQuality,
  CharacterReferenceRole,
} from "@/lib/types";
import { CharacterFormState } from "./types";

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
