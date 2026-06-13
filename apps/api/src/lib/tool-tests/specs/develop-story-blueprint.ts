import type { ToolBattery } from "../types";
import { pendingBattery } from "./_pending";

// TODO: wire develop_story_blueprint, then replace pendingBattery(...) with real
// `active` cases (see create-or-load-brief.ts / plan-shots.ts).
export const developStoryBlueprintBattery: ToolBattery = pendingBattery(
  "develop_story_blueprint",
  "Develop the story blueprint for a 30-second brand video about a cozy neighborhood coffee shop."
);
