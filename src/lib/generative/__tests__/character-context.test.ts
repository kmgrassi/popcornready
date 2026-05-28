import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  buildCharacterPrompt,
  parseConsistencyMode,
  resolveCharacterGenerationContext,
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

test("buildCharacterPrompt composes invariants, shot delta, and prompt", () => {
  const project = projectFixture();
  const prompt = buildCharacterPrompt({
    profiles: project.characterProfiles || [],
    prompt: "She opens the lab notebook.",
    shotDelta: { camera: "slow push-in", emotion: "curious" },
  });

  assert.match(prompt, /Character: Ada/);
  assert.match(prompt, /Identity invariants: dark curled hair, focused gaze/);
  assert.match(prompt, /Wardrobe invariants: navy dress/);
  assert.match(prompt, /Avoid: modern clothing/);
  assert.match(prompt, /Camera: slow push-in/);
  assert.match(prompt, /She opens the lab notebook\./);
});

test("resolveCharacterGenerationContext accepts approved references", () => {
  const context = resolveCharacterGenerationContext({
    project: projectFixture(),
    provider: "mock",
    kind: "image",
    prompt: "Generate a portrait.",
    publicRoot: path.join(process.cwd(), "public"),
    characterProfileIds: ["char_ada"],
    characterReferenceIds: ["ref_front"],
    consistencyMode: parseConsistencyMode("reference_pack"),
    shotDelta: { action: "turns a page" },
  });

  assert.equal(context?.consistencyMode, "reference_pack");
  assert.deepEqual(
    context?.references.map(({ reference }) => reference.id),
    ["ref_front"]
  );
  assert.ok(context?.promptInvariantVersion);
});

test("resolveCharacterGenerationContext rejects missing profiles and rejected references", () => {
  assert.throws(
    () =>
      resolveCharacterGenerationContext({
        project: projectFixture(),
        provider: "mock",
        kind: "image",
        prompt: "Generate.",
        publicRoot: path.join(process.cwd(), "public"),
        characterProfileIds: ["missing"],
        consistencyMode: parseConsistencyMode("prompt_only"),
      }),
    /Unknown character profile/
  );

  assert.throws(
    () =>
      resolveCharacterGenerationContext({
        project: projectFixture(),
        provider: "mock",
        kind: "image",
        prompt: "Generate.",
        publicRoot: path.join(process.cwd(), "public"),
        characterProfileIds: ["char_ada"],
        characterReferenceIds: ["ref_bad"],
        consistencyMode: parseConsistencyMode("reference_pack"),
      }),
    /is not approved/
  );
});

test("resolveCharacterGenerationContext rejects profiles with blank identity invariants", () => {
  const project = projectFixture();
  project.characterProfiles![0].identityInvariants = "   ";

  assert.throws(
    () =>
      resolveCharacterGenerationContext({
        project,
        provider: "mock",
        kind: "image",
        prompt: "Generate.",
        publicRoot: path.join(process.cwd(), "public"),
        characterProfileIds: ["char_ada"],
        consistencyMode: parseConsistencyMode("prompt_only"),
      }),
    /identityInvariants are blank/
  );
});
