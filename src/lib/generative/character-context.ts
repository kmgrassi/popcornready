import { createHash } from "crypto";
import path from "path";
import type {
  CharacterConsistencyMode,
  CharacterProfile,
  CharacterReference,
  Clip,
  Project,
} from "@/lib/types";
import {
  CharacterGenerationContext,
  CharacterReferenceInput,
  GenerativeAssetKind,
  GenerativeProviderName,
  ShotDelta,
} from "./types";

export const CHARACTER_CONSISTENCY_MODES: CharacterConsistencyMode[] = [
  "prompt_only",
  "reference_pack",
  "hero_frame",
  "first_frame_video",
  "fine_tuned",
];

const SUPPORTED_MODES: Record<
  GenerativeProviderName,
  Partial<Record<GenerativeAssetKind, CharacterConsistencyMode[]>>
> = {
  openai: {
    image: ["prompt_only", "reference_pack", "hero_frame"],
    video: ["prompt_only", "hero_frame", "first_frame_video"],
  },
  gemini: {
    video: ["prompt_only", "hero_frame", "first_frame_video"],
  },
  mock: {
    image: ["prompt_only", "reference_pack", "hero_frame", "first_frame_video"],
    video: ["prompt_only", "reference_pack", "hero_frame", "first_frame_video"],
  },
  elevenlabs: {
    audio: ["prompt_only"],
  },
  nanobanano: {},
};

export function parseConsistencyMode(value: unknown): CharacterConsistencyMode {
  const mode = String(value || "prompt_only");
  if (!CHARACTER_CONSISTENCY_MODES.includes(mode as CharacterConsistencyMode)) {
    throw new Error(`Unsupported consistencyMode: ${mode}.`);
  }
  return mode as CharacterConsistencyMode;
}

export function ensureProviderSupportsCharacterMode(
  provider: GenerativeProviderName,
  kind: GenerativeAssetKind,
  mode: CharacterConsistencyMode
) {
  const supported = SUPPORTED_MODES[provider]?.[kind] || [];
  if (!supported.includes(mode)) {
    throw new Error(
      `${provider} ${kind} generation does not support consistencyMode=${mode}.`
    );
  }
}

export function promptInvariantVersion(profiles: CharacterProfile[]): string {
  const payload = profiles
    .map((profile) => ({
      id: profile.id,
      identityInvariants: profile.identityInvariants,
      styleInvariants: profile.styleInvariants || "",
      wardrobeInvariants: profile.wardrobeInvariants || "",
      negativePrompt: profile.negativePrompt || "",
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")
    .slice(0, 12);
}

export function buildCharacterPrompt(input: {
  profiles: CharacterProfile[];
  prompt: string;
  shotDelta?: ShotDelta;
}): string {
  const invariantBlocks = input.profiles.map((profile) =>
    [
      `Character: ${profile.name}`,
      profile.description ? `Description: ${profile.description}` : "",
      `Identity invariants: ${profile.identityInvariants}`,
      profile.styleInvariants ? `Style invariants: ${profile.styleInvariants}` : "",
      profile.wardrobeInvariants
        ? `Wardrobe invariants: ${profile.wardrobeInvariants}`
        : "",
      "Do not redesign the character. Preserve the same face, body, age, proportions, and recognizable identity unless the shot delta explicitly says otherwise.",
      profile.negativePrompt ? `Avoid: ${profile.negativePrompt}` : "",
    ]
      .filter(Boolean)
      .join("\n")
  );

  const shotDeltaLines = [
    input.shotDelta?.prompt || input.prompt,
    input.shotDelta?.action ? `Action: ${input.shotDelta.action}` : "",
    input.shotDelta?.camera ? `Camera: ${input.shotDelta.camera}` : "",
    input.shotDelta?.setting ? `Setting: ${input.shotDelta.setting}` : "",
    input.shotDelta?.emotion ? `Emotion: ${input.shotDelta.emotion}` : "",
  ].filter(Boolean);

  return [
    invariantBlocks.length > 0 ? "[character identity invariants]" : "",
    ...invariantBlocks,
    "[shot delta prompt]",
    ...shotDeltaLines,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function assertLocalPublicPath(url: string, publicRoot: string): string {
  if (!url.startsWith("/uploads/") && !url.startsWith("/generated/")) {
    throw new Error(`Character reference asset must be local: ${url}.`);
  }
  const filePath = path.normalize(path.join(publicRoot, url));
  if (!filePath.startsWith(publicRoot)) {
    throw new Error(`Character reference asset path escapes public root: ${url}.`);
  }
  return filePath;
}

export function resolveCharacterGenerationContext(input: {
  project: Project;
  provider: GenerativeProviderName;
  kind: GenerativeAssetKind;
  prompt: string;
  publicRoot: string;
  characterProfileIds: string[];
  characterReferenceIds?: string[];
  consistencyMode: CharacterConsistencyMode;
  shotDelta?: ShotDelta;
}): CharacterGenerationContext | undefined {
  if (input.characterProfileIds.length === 0 && !input.characterReferenceIds?.length) {
    return undefined;
  }

  ensureProviderSupportsCharacterMode(
    input.provider,
    input.kind,
    input.consistencyMode
  );

  const profiles = input.characterProfileIds.map((id) => {
    const profile = input.project.characterProfiles?.find((item) => item.id === id);
    if (!profile) throw new Error(`Unknown character profile: ${id}.`);
    if (profile.status === "archived") {
      throw new Error(`Character profile is archived: ${id}.`);
    }
    return profile;
  });

  const profileIds = new Set(profiles.map((profile) => profile.id));
  const allReferences = input.project.characterReferences || [];
  const requestedReferenceIds = input.characterReferenceIds || [];
  const references =
    requestedReferenceIds.length > 0
      ? requestedReferenceIds.map((id) => {
          const reference = allReferences.find((item) => item.id === id);
          if (!reference) throw new Error(`Unknown character reference: ${id}.`);
          return reference;
        })
      : allReferences.filter(
          (reference) =>
            profileIds.has(reference.characterProfileId) &&
            reference.quality === "approved"
        );

  for (const reference of references) {
    if (!profileIds.has(reference.characterProfileId)) {
      throw new Error(
        `Character reference ${reference.id} does not belong to a selected profile.`
      );
    }
    if (reference.quality !== "approved") {
      throw new Error(`Character reference ${reference.id} is not approved.`);
    }
  }

  const selectedReferences =
    input.consistencyMode === "prompt_only"
      ? []
      : input.consistencyMode === "hero_frame" ||
          input.consistencyMode === "first_frame_video"
      ? preferHeroReference(references).slice(0, 1)
      : references;

  if (input.consistencyMode !== "prompt_only" && selectedReferences.length === 0) {
    throw new Error(
      `consistencyMode=${input.consistencyMode} requires at least one approved character reference.`
    );
  }

  const clipsById = new Map(input.project.clips.map((clip: Clip) => [clip.id, clip]));
  const referenceInputs: CharacterReferenceInput[] = selectedReferences.map(
    (reference: CharacterReference) => {
      const clip = clipsById.get(reference.assetId);
      if (!clip) {
        throw new Error(`Character reference ${reference.id} points to a missing asset.`);
      }
      if ((clip.kind || "video") !== "image") {
        throw new Error(`Character reference ${reference.id} must point to an image.`);
      }
      return {
        reference,
        assetId: clip.id,
        path: assertLocalPublicPath(clip.url, input.publicRoot),
        url: clip.url,
      };
    }
  );

  return {
    profiles,
    references: referenceInputs,
    consistencyMode: input.consistencyMode,
    promptInvariantVersion: promptInvariantVersion(profiles),
    originalPrompt: input.prompt,
    shotDelta: input.shotDelta,
  };
}

function preferHeroReference(references: CharacterReference[]): CharacterReference[] {
  return [...references].sort((a, b) => {
    if (a.role === "hero_frame" && b.role !== "hero_frame") return -1;
    if (b.role === "hero_frame" && a.role !== "hero_frame") return 1;
    return a.id.localeCompare(b.id);
  });
}
