import type { ToolBattery } from "../types";
import { pendingBattery } from "./_pending";

// TODO: wire plan_visual_anchors, then replace pendingBattery(...) with real
// `active` cases (see create-or-load-brief.ts / plan-shots.ts).
export const planVisualAnchorsBattery: ToolBattery = pendingBattery(
  "plan_visual_anchors",
  "Identify the recurring characters, locations, and props that need visual anchors."
);
