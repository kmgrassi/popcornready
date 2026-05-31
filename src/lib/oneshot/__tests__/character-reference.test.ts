import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOneShotCharacterDraft,
  describeRecurringCharacter,
  oneShotCharacterBinding,
  oneShotCharacterContext,
  oneShotHeroFramePrompt,
} from "../character-reference";

test("describeRecurringCharacter extracts age and role from the creative brief", () => {
  const character = describeRecurringCharacter(
    "Create a film about a 10-year-old movie-loving boy discovering Popcorn Ready."
  );

  assert.equal(character.age, "10-year-old");
  assert.equal(character.role, "movie-loving boy");
  assert.match(character.identityInvariants, /same 10-year-old movie-loving boy/);
  assert.match(character.negativePrompt, /recast/);
});

test("oneShotHeroFramePrompt includes story context and reference constraints", () => {
  const prompt = oneShotHeroFramePrompt({
    goal: "A young filmmaker dreams of making a movie.",
    style: "cinematic",
  });

  assert.match(prompt, /hero-frame image/);
  assert.match(prompt, /Story context/);
  assert.match(prompt, /No text/);
});

test("oneShotCharacterContext and binding preserve hero-frame reference metadata", () => {
  const draft = buildOneShotCharacterDraft({
    goal: "A 10-year-old boy makes a film.",
    projectId: "default",
    profileId: "char_123",
    referenceId: "ref_123",
    assetId: "img_123",
    now: "2026-01-01T00:00:00.000Z",
  });
  const context = oneShotCharacterContext({
    profile: draft.profile,
    reference: draft.reference,
    referencePath: "/tmp/hero.png",
    referenceUrl: "/generated/hero.png",
    originalPrompt: "A 10-year-old boy makes a film.",
    providerPrompt: "Beat prompt",
  });
  const binding = oneShotCharacterBinding({
    assetId: "vid_123",
    context,
    providerSettings: {
      provider: "gemini",
      references: ["ref_123"],
      mode: "hero_frame",
      promptInvariantVersion: context.promptInvariantVersion,
    },
  });

  assert.equal(context.consistencyMode, "hero_frame");
  assert.equal(context.references[0].path, "/tmp/hero.png");
  assert.deepEqual(binding.characterProfileIds, ["char_123"]);
  assert.deepEqual(binding.referenceIds, ["ref_123"]);
  assert.equal(binding.assetId, "vid_123");
});
