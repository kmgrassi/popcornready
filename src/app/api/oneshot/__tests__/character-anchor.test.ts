import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";

import { characterAnchorAsset } from "../media-generation";
import {
  characterAnchorPool,
  resumableCharacterForGoal,
  resumableCharacterFromAnchor,
} from "../project-cache";
import { getSelection, resolveActiveAsset } from "@/lib/assets/pool";
import type { CharacterProfile, Clip, Project } from "@/lib/types";

// asset-pool PR E — folding the recurring character into a `character_anchor`
// asset + selection (docs/scopes/north-star-asset-pool.md, NORTH_STAR.md §8).

const PROFILE: CharacterProfile = {
  id: "char_anchor1",
  projectId: "default",
  name: "One-shot protagonist",
  description: "Recurring protagonist.",
  identityInvariants: "Keep the same 10-year-old filmmaker across every shot.",
  wardrobeInvariants: "Keep the recognizable wardrobe anchor.",
  negativePrompt: "Do not recast or age-shift the protagonist.",
  status: "ready",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function heroClip(url: string): Clip {
  return {
    id: "img_hero1",
    filename: "img_hero1_hero.png",
    url,
    kind: "image",
    durationSec: 4,
    description: "Generated one-shot protagonist hero reference.",
    source: "generated",
    generatedBy: { provider: "openai", model: "gpt-image-1", prompt: "hero" },
  };
}

test("characterAnchorAsset folds the profile into a character_anchor asset", () => {
  const anchor = characterAnchorAsset({
    profile: PROFILE,
    clip: heroClip("/generated/img_hero1_hero.png"),
  });

  assert.equal(anchor.role, "character_anchor");
  assert.equal(anchor.kind, "image");
  assert.equal(anchor.projectId, "default");
  // depicts.characterId is the self-describing link to the character.
  assert.equal(anchor.depicts?.characterId, "char_anchor1");
  // Identity invariants are folded from the legacy CharacterProfile.
  assert.equal(anchor.characterInvariants?.identity, PROFILE.identityInvariants);
  assert.equal(anchor.characterInvariants?.wardrobe, PROFILE.wardrobeInvariants);
  assert.equal(anchor.characterInvariants?.negative, PROFILE.negativePrompt);
  // The anchor reuses the hero clip id so it resolves back to the clip/file.
  assert.equal(anchor.id, "img_hero1");
});

test("characterAnchorPool builds the asset + character_anchor selection", () => {
  const anchor = characterAnchorAsset({
    profile: PROFILE,
    clip: heroClip("/generated/img_hero1_hero.png"),
  });
  const pool = characterAnchorPool(anchor);

  assert.deepEqual(pool.assets, [anchor]);
  assert.equal(pool.selections.length, 1);
  assert.deepEqual(pool.selections[0], {
    slotKind: "character_anchor",
    slotKey: "char_anchor1",
    activeAssetId: "img_hero1",
  });
});

test("resumableCharacterFromAnchor resolves the character via the active selection", () => {
  const anchor = characterAnchorAsset({
    profile: PROFILE,
    clip: heroClip("/generated/img_hero1_hero.png"),
  });
  const pool = characterAnchorPool(anchor);
  const project: Project = {
    id: "default",
    goal: "g",
    plan: null,
    timeline: null,
    clips: [heroClip("/generated/img_hero1_hero.png")],
    assets: pool.assets,
    selections: pool.selections,
    characterProfiles: [PROFILE],
    characterReferences: [
      {
        id: "ref_1",
        characterProfileId: PROFILE.id,
        assetId: "img_hero1",
        role: "hero_frame",
        quality: "approved",
      },
    ],
    critic: null,
    chat: [],
    updatedAt: "t",
  };

  // The selection points at the pooled anchor (the self-describing replacement
  // for the "approved hero_frame" scan).
  assert.equal(getSelection(project, "character_anchor", PROFILE.id), "img_hero1");
  assert.equal(
    resolveActiveAsset(project, "character_anchor", PROFILE.id)?.role,
    "character_anchor"
  );

  const resolved = resumableCharacterFromAnchor(project);
  assert.ok(resolved, "resolves via the character_anchor selection");
  assert.equal(resolved!.anchor.id, "img_hero1");
  assert.equal(resolved!.profile.id, PROFILE.id);
  assert.equal(resolved!.clip.id, "img_hero1");
});

test("resumableCharacterForGoal prefers the pooled character_anchor selection", async () => {
  const dataDir = path.join(process.cwd(), "data");
  const projectFile = path.join(dataDir, "project.json");
  const generatedDir = path.join(process.cwd(), "public", "generated");
  const heroFile = path.join(generatedDir, "img_hero1_hero.png");

  // Preserve any real persisted project so the test never clobbers app state.
  let priorProject: string | null = null;
  try {
    priorProject = await fs.readFile(projectFile, "utf8");
  } catch {
    priorProject = null;
  }

  await fs.mkdir(generatedDir, { recursive: true });
  await fs.writeFile(heroFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const anchor = characterAnchorAsset({
    profile: PROFILE,
    clip: heroClip("/generated/img_hero1_hero.png"),
  });
  const pool = characterAnchorPool(anchor);
  const project: Project = {
    id: "default",
    goal: "resume-anchor-goal",
    plan: null,
    timeline: null,
    clips: [heroClip("/generated/img_hero1_hero.png")],
    assets: pool.assets,
    selections: pool.selections,
    characterProfiles: [PROFILE],
    // A persisted reference still rides along for the keyframe path, but it is
    // intentionally NOT an approved hero_frame: resolution must come from the
    // character_anchor selection, not the legacy role/quality scan.
    characterReferences: [
      {
        id: "ref_1",
        characterProfileId: PROFILE.id,
        assetId: "img_hero1",
        role: "front_portrait",
        quality: "candidate",
      },
    ],
    critic: null,
    chat: [],
    updatedAt: "t",
  };

  try {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(projectFile, JSON.stringify(project, null, 2), "utf8");

    const resumed = await resumableCharacterForGoal("resume-anchor-goal");
    assert.ok(resumed, "resumes via the character_anchor selection");
    assert.equal(resumed!.anchor.role, "character_anchor");
    assert.equal(resumed!.anchor.depicts?.characterId, PROFILE.id);
    assert.equal(resumed!.profile.id, PROFILE.id);
    assert.equal(resumed!.path, heroFile);
  } finally {
    await fs.rm(heroFile, { force: true });
    if (priorProject !== null) {
      await fs.writeFile(projectFile, priorProject, "utf8");
    } else {
      await fs.rm(projectFile, { force: true });
    }
  }
});
