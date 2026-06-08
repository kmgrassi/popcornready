// Default storyboard tile fan-out for the `storyboard` generation stage
// (Storyboard & Scenes scope, Part B).
//
// Iterates the plan's scenes → beats and generates exactly one cheap sketch
// `beat_storyboard` tile per beat, returning them as pooled Assets. Decoupled
// from the run executor (injected via GenerationDeps.generateStoryboardTiles) so
// the executor can be exercised offline; this module owns the on-disk path +
// provider plumbing.

import path from "path";
import type { EditPlan, Scene } from "@popcorn/shared/types";
import type { Asset } from "@popcorn/shared/assets/types";
import { randomUUID } from "crypto";
import {
  generateStoryboardTile,
  type StoryboardTileProvider,
} from "@/lib/generative/storyboard-tile";
import { localDir, mediaGeneratedDir } from "@/lib/api/v1/store";

// The storyboard stage is a low-cost preview, so it uses the cheap default image
// provider unless the environment pins one (e.g. `mock` in tests/CI without
// provider keys).
function tileProvider(): StoryboardTileProvider | undefined {
  const pinned = process.env.STORYBOARD_TILE_PROVIDER;
  if (pinned === "mock" || pinned === "gemini" || pinned === "openai") {
    return pinned;
  }
  return undefined;
}

export async function generateStoryboardTilesForPlan(input: {
  workspaceId: string;
  projectId: string;
  plan: EditPlan;
}): Promise<Asset[]> {
  const outputDir = mediaGeneratedDir(input.workspaceId, input.projectId);
  const provider = tileProvider();

  const tiles: Asset[] = [];
  for (const scene of input.plan.scenes) {
    for (const beat of scene.beats) {
      const tile = await generateOne({
        projectId: input.projectId,
        scene,
        beat,
        outputDir,
        provider,
      });
      tiles.push(tile);
    }
  }
  return tiles;
}

async function generateOne(input: {
  projectId: string;
  scene: Scene;
  beat: Scene["beats"][number];
  outputDir: string;
  provider?: StoryboardTileProvider;
}): Promise<Asset> {
  return generateStoryboardTile({
    projectId: input.projectId,
    scene: input.scene,
    beat: input.beat,
    ...(input.scene.anchorAssetId ? { sceneAnchorAssetId: input.scene.anchorAssetId } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    outputDir: input.outputDir,
    // The pooled asset's url is the storage-relative locator (consistent with
    // the generated-asset storageKey); the serving layer resolves it.
    publicUrlFor: (filename) =>
      path.relative(localDir(), path.join(input.outputDir, filename)),
    newId: () => randomUUID(),
  });
}
