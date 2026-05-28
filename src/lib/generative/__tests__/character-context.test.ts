import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCharacterInvariantPrompt,
  CharacterContextValidationError,
  parseCharacterGenerationFields,
  resolveCharacterContext,
} from "../character-context";
import { Project } from "../../types";

function projectFixture(): Project {
  return {
    id: "default",
    goal: "",
    plan: null,
    timeline: null,
    clips: [
      {
        id: "clip_front",
        filename: "front.png",
        url: "/uploads/front.png",
        kind: "image",
        durationSec: 4,
        description: "",
      },
      {
        id: "clip_rejected",
        filename: "rejected.png",
        url: "/uploads/rejected.png",
        kind: "image",
        durationSec: 4,
        description: "",
      },
    ],
    characterProfiles: [
      {
        id: "char_ada",
        projectId: "default",
        name: "Ada",
        description: "Victorian mathematician",
        identityInvariants: "dark curled hair, focused gaze",
        wardrobeInvariants: "navy dress",
        negativePrompt: "modern clothing",
        status: "ready",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    characterReferences: [
      {
        id: "ref_front",
        characterProfileId: "char_ada",
        assetId: "clip_front",
        role: "front_portrait",
        quality: "approved",
      },
      {
        id: "ref_bad",
        characterProfileId: "char_ada",
        assetId: "clip_rejected",
        role: "front_portrait",
        quality: "rejected",
      },
    ],
    critic: null,
    chat: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("buildCharacterInvariantPrompt composes invariants, shot delta, and prompt", () => {
  const project = projectFixture();
  const prompt = buildCharacterInvariantPrompt(
    project.characterProfiles || [],
    "She opens the lab notebook.",
    { camera: "slow push-in", emotion: "curious" }
  );

  assert.match(prompt, /Character: Ada/);
  assert.match(prompt, /Identity invariants: dark curled hair, focused gaze/);
  assert.match(prompt, /Wardrobe invariants: navy dress/);
  assert.match(prompt, /Avoid: modern clothing/);
  assert.match(prompt, /camera: slow push-in/);
  assert.match(prompt, /Prompt:\nShe opens the lab notebook\./);
});

test("resolveCharacterContext accepts approved references", () => {
  const context = resolveCharacterContext(
    projectFixture(),
    parseCharacterGenerationFields({
      characterProfileIds: ["char_ada"],
      characterReferenceIds: ["ref_front"],
      consistencyMode: "reference_pack",
      shotDelta: { action: "turns a page" },
    }),
    "Generate a portrait."
  );

  assert.equal(context?.consistencyMode, "reference_pack");
  assert.deepEqual(
    context?.references.map((reference) => reference.id),
    ["ref_front"]
  );
  assert.equal(context?.promptInvariantVersion, "character-invariants-v1");
});

test("resolveCharacterContext rejects missing profiles and rejected references", () => {
  assert.throws(
    () =>
      resolveCharacterContext(
        projectFixture(),
        parseCharacterGenerationFields({ characterProfileIds: ["missing"] }),
        "Generate."
      ),
    CharacterContextValidationError
  );

  assert.throws(
    () =>
      resolveCharacterContext(
        projectFixture(),
        parseCharacterGenerationFields({
          characterProfileIds: ["char_ada"],
          characterReferenceIds: ["ref_bad"],
          consistencyMode: "reference_pack",
        }),
        "Generate."
      ),
    /Character reference is rejected/
  );
});
