import type { ToolBattery } from "../types";
import { pendingBattery } from "./_pending";

// TODO: wire generate_storyboard, then replace pendingBattery(...) with real
// `active` cases (see create-or-load-brief.ts / plan-shots.ts).
export const generateStoryboardBattery: ToolBattery = pendingBattery(
  "generate_storyboard",
  "Generate storyboard frames for the planned beats."
);
