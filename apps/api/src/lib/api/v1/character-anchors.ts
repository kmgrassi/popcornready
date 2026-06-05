// P2 (granular generation API §3 "Anchor / character image"): generate or
// regenerate a character's reference likeness — the "anchor" — over a dedicated
// endpoint.
//
// This is a THIN WRAPPER (decision §6.3): it resolves the character, records the
// character binding / provenance (so selective regeneration can follow the
// dependency graph), and delegates the actual image generation + Job + poll to
// the existing `createGeneratedAsset` primitive. It does NOT reimplement the
// provider pipeline.
//
// Pre/postcondition contract (decision §6.3, NORTH_STAR principle 7): an unknown
// character returns a structured `not_found` ApiError naming what's missing; an
// `autocreate` opt-in lets convenience-first callers materialize the character
// anchor record on the fly instead of failing.

import { registerAsset as registerAssetImpl } from "./assets";
import { AuthContext } from "./auth";
import { ApiError } from "./errors";
import {
  ApiResult,
  createGeneratedAsset as createGeneratedAssetImpl,
} from "./generated-assets";
import { getAsset as getAssetImpl, V1Asset } from "./store";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// Mirrors store.isCharacterAnchorAsset (not exported there): an asset is a valid
// anchor target if it was registered as a character (name / intended use /
// recommended role). This keeps the precondition honest — we won't bind a likeness
// to an arbitrary clip.
function isCharacterAnchorAsset(asset: V1Asset): boolean {
  return Boolean(
    asset.userContext?.characterNames?.length ||
      asset.userContext?.intendedUse?.includes("character_reference") ||
      asset.context?.recommendedRoles?.some((role) => /character/i.test(role))
  );
}

function characterName(asset: V1Asset, fallback: string): string {
  return (
    asset.userContext?.characterNames?.[0] ??
    asset.userContext?.title ??
    asset.filename ??
    fallback
  );
}

// Injectable seams (default to the real implementations). Keeping these as a
// `deps` arg lets the unit test exercise the wiring offline without a live
// Supabase or any image provider — and without module-mocking machinery.
export interface CharacterAnchorDeps {
  getAsset: typeof getAssetImpl;
  createGeneratedAsset: typeof createGeneratedAssetImpl;
  registerAsset: typeof registerAssetImpl;
}

const defaultDeps: CharacterAnchorDeps = {
  getAsset: getAssetImpl,
  createGeneratedAsset: createGeneratedAssetImpl,
  registerAsset: registerAssetImpl,
};

export interface GenerateCharacterAnchorArgs {
  auth: AuthContext;
  projectId: string;
  characterId: string;
  body: unknown;
  deps?: Partial<CharacterAnchorDeps>;
}

/**
 * Generate / regenerate the reference likeness image (anchor) for a character.
 *
 * Reuses `createGeneratedAsset` (image path) with the character bound into
 * provenance (`characterProfileIds: [characterId]`) and the resulting asset
 * tagged as a `character_anchor`. Returns the same pollable `Job` envelope the
 * generic generated-assets endpoint returns, so callers use one client pattern.
 */
export async function generateCharacterAnchor(
  args: GenerateCharacterAnchorArgs
): Promise<ApiResult> {
  const { auth, projectId, characterId } = args;
  const { getAsset, createGeneratedAsset, registerAsset } = {
    ...defaultDeps,
    ...args.deps,
  };
  const body = isPlainObject(args.body) ? args.body : {};

  const autocreate = body.autocreate === true;

  // Precondition: the character must exist. `getAsset` throws a structured
  // `not_found` ApiError for an unknown id — exactly the typed precondition the
  // agent self-heals against (decision §6.3). `autocreate=true` opts into
  // materializing the anchor record instead of failing.
  let character: V1Asset;
  try {
    character = await getAsset(auth.workspaceId, projectId, characterId);
  } catch (err) {
    if (err instanceof ApiError && err.code === "not_found" && autocreate) {
      character = await autocreateCharacter(registerAsset, auth, projectId, characterId, body);
    } else {
      throw err;
    }
  }

  // Precondition: the resolved asset must actually be a character anchor — not an
  // arbitrary clip/upload. Structured, actionable error (NORTH_STAR principle 7).
  if (!isCharacterAnchorAsset(character)) {
    throw new ApiError(
      "asset_invalid",
      `Asset ${characterId} is not a character. Create one via POST /projects/${projectId}/characters first, or pass autocreate=true.`,
      { assetIds: [characterId] }
    );
  }

  const name = characterName(character, characterId);
  const prompt =
    optionalString(body.prompt) ??
    optionalString(character.context?.summary) ??
    optionalString(character.userContext?.description) ??
    `Reference likeness portrait of ${name}.`;

  // Build the generated-assets request. We force an image anchor and bind the
  // character (provenance). `characterProfileIds` is what drives the binding in
  // `createGeneratedAsset` (it records characterBinding.characterProfileIds).
  // Existing references for the character can be passed via `referenceAssetIds`
  // / `characterReferenceIds`; both flow straight through.
  const generatedAssetBody: Record<string, unknown> = {
    ...body,
    kind: "image",
    prompt,
    provider: optionalString(body.provider) ?? "openai",
    description:
      optionalString(body.description) ??
      `Character anchor likeness for ${name}.`,
    characterProfileIds: [characterId],
  };
  delete generatedAssetBody.autocreate;

  return createGeneratedAsset({
    auth,
    projectId,
    body: generatedAssetBody,
  });
}

async function autocreateCharacter(
  registerAsset: typeof registerAssetImpl,
  auth: AuthContext,
  projectId: string,
  characterId: string,
  body: Record<string, unknown>
): Promise<V1Asset> {
  // Materialize a character-anchor placeholder asset so the binding has a real
  // target. Matches the shape miscCapabilitiesRouter POST /characters produces.
  const name =
    optionalString(body.name) ??
    optionalString(body.characterName) ??
    characterId;
  return registerAsset(auth, projectId, {
    source: {
      type: "remote_url",
      url: `https://popcornready.local/character-anchors/${encodeURIComponent(name)}`,
    },
    kind: "image",
    filename: `${name.replace(/[^a-zA-Z0-9._-]/g, "_")}.character_anchor`,
    context: {
      summary: optionalString(body.description),
      recommendedRoles: ["character_anchor"],
    },
    userContext: {
      title: name,
      description: optionalString(body.description),
      characterNames: [name],
      intendedUse: ["character_reference"],
      tags: ["character_anchor"],
    },
  });
}
