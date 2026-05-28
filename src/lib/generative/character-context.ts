import {
  CharacterConsistencyMode,
  CharacterProfile,
  CharacterReference,
  GeneratedAssetCharacterBinding,
  Project,
  ShotDelta,
} from "@/lib/types";

export const CHARACTER_PROMPT_INVARIANT_VERSION = "character-invariants-v1";

const SUPPORTED_CONSISTENCY_MODES: CharacterConsistencyMode[] = [
  "prompt_only",
  "reference_pack",
  "hero_frame",
  "first_frame_video",
];

export interface CharacterGenerationFields {
  characterProfileIds: string[];
  characterReferenceIds: string[];
  consistencyMode?: CharacterConsistencyMode;
  shotDelta?: ShotDelta;
}

export interface ResolvedCharacterContext {
  profiles: CharacterProfile[];
  references: CharacterReference[];
  consistencyMode: CharacterConsistencyMode;
  shotDelta?: ShotDelta;
  promptInvariantVersion: string;
  invariantPrompt: string;
}

export class CharacterContextValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CharacterContextValidationError";
  }
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String).map((item) => item.trim()).filter(Boolean);
}

export function parseCharacterGenerationFields(
  body: Record<string, unknown>
): CharacterGenerationFields {
  const mode = body.consistencyMode
    ? (String(body.consistencyMode) as CharacterConsistencyMode)
    : undefined;
  const shotDelta =
    body.shotDelta && typeof body.shotDelta === "object" && !Array.isArray(body.shotDelta)
      ? Object.fromEntries(
          Object.entries(body.shotDelta as Record<string, unknown>)
            .map(([key, value]) => [key, String(value || "").trim()])
            .filter(([, value]) => Boolean(value))
        )
      : undefined;

  return {
    characterProfileIds: asStringArray(body.characterProfileIds),
    characterReferenceIds: asStringArray(body.characterReferenceIds),
    consistencyMode: mode,
    shotDelta,
  };
}

export function hasCharacterGenerationFields(
  fields: CharacterGenerationFields
): boolean {
  return Boolean(
    fields.characterProfileIds.length ||
      fields.characterReferenceIds.length ||
      fields.consistencyMode ||
      fields.shotDelta
  );
}

export function buildCharacterInvariantPrompt(
  profiles: CharacterProfile[],
  shotPrompt: string,
  shotDelta?: ShotDelta
): string {
  const blocks = profiles.map((profile) => {
    const lines = [
      `Character: ${profile.name}`,
      profile.description ? `Description: ${profile.description}` : "",
      `Identity invariants: ${profile.identityInvariants}`,
      profile.styleInvariants ? `Style invariants: ${profile.styleInvariants}` : "",
      profile.wardrobeInvariants
        ? `Wardrobe invariants: ${profile.wardrobeInvariants}`
        : "",
      profile.negativePrompt ? `Avoid: ${profile.negativePrompt}` : "",
    ].filter(Boolean);
    return lines.join("\n");
  });

  const shotDeltaLines = shotDelta
    ? Object.entries(shotDelta)
        .filter(([, value]) => Boolean(value))
        .map(([key, value]) => `${key}: ${value}`)
    : [];

  return [
    ...blocks,
    shotDeltaLines.length ? `Shot delta:\n${shotDeltaLines.join("\n")}` : "",
    shotPrompt ? `Prompt:\n${shotPrompt}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function resolveCharacterContext(
  project: Project,
  fields: CharacterGenerationFields,
  shotPrompt: string
): ResolvedCharacterContext | null {
  if (!hasCharacterGenerationFields(fields)) return null;

  const consistencyMode = fields.consistencyMode || "prompt_only";
  if (!SUPPORTED_CONSISTENCY_MODES.includes(consistencyMode)) {
    throw new CharacterContextValidationError(
      `Unsupported consistencyMode: ${consistencyMode}`
    );
  }

  const profiles = fields.characterProfileIds.map((id) => {
    const profile = project.characterProfiles?.find((candidate) => candidate.id === id);
    if (!profile) throw new CharacterContextValidationError(`Character profile not found: ${id}`);
    if (profile.status === "archived") {
      throw new CharacterContextValidationError(`Character profile is archived: ${id}`);
    }
    return profile;
  });

  if (fields.characterReferenceIds.length && profiles.length === 0) {
    throw new CharacterContextValidationError(
      "characterProfileIds are required when characterReferenceIds are provided."
    );
  }

  const profileIds = new Set(profiles.map((profile) => profile.id));
  const references = fields.characterReferenceIds.map((id) => {
    const reference = project.characterReferences?.find((candidate) => candidate.id === id);
    if (!reference) {
      throw new CharacterContextValidationError(`Character reference not found: ${id}`);
    }
    if (!profileIds.has(reference.characterProfileId)) {
      throw new CharacterContextValidationError(
        `Character reference does not belong to a selected profile: ${id}`
      );
    }
    if (reference.quality === "rejected") {
      throw new CharacterContextValidationError(`Character reference is rejected: ${id}`);
    }
    if (!project.clips.some((clip) => clip.id === reference.assetId)) {
      throw new CharacterContextValidationError(
        `Character reference asset not found: ${reference.assetId}`
      );
    }
    return reference;
  });

  if (
    consistencyMode !== "prompt_only" &&
    fields.characterReferenceIds.length === 0
  ) {
    throw new CharacterContextValidationError(
      `consistencyMode=${consistencyMode} requires at least one characterReferenceId.`
    );
  }

  return {
    profiles,
    references,
    consistencyMode,
    shotDelta: fields.shotDelta,
    promptInvariantVersion: CHARACTER_PROMPT_INVARIANT_VERSION,
    invariantPrompt: buildCharacterInvariantPrompt(profiles, shotPrompt, fields.shotDelta),
  };
}

export function characterBindingForAsset(
  assetId: string,
  context: ResolvedCharacterContext
): GeneratedAssetCharacterBinding {
  return {
    assetId,
    characterProfileIds: context.profiles.map((profile) => profile.id),
    referenceIds: context.references.map((reference) => reference.id),
    consistencyMode: context.consistencyMode,
    shotDelta: context.shotDelta,
    promptInvariantVersion: context.promptInvariantVersion,
  };
}
