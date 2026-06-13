import type { ToolBattery } from "../types";
import { pendingBattery } from "./_pending";

// TODO: wire generate_clip, then replace pendingBattery(...) with real `active`
// cases (see create-or-load-brief.ts / plan-shots.ts).
export const generateClipBattery: ToolBattery = pendingBattery(
  "generate_clip",
  "Generate a motion clip for the opening beat."
);
