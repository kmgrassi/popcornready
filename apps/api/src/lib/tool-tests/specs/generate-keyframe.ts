import type { ToolBattery } from "../types";
import { pendingBattery } from "./_pending";

// TODO: wire generate_keyframe, then replace pendingBattery(...) with real
// `active` cases (see create-or-load-brief.ts / plan-shots.ts).
export const generateKeyframeBattery: ToolBattery = pendingBattery(
  "generate_keyframe",
  "Generate a keyframe image for the opening beat."
);
