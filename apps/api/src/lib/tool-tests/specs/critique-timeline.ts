import type { ToolBattery } from "../types";
import { pendingBattery } from "./_pending";

// TODO: wire critique_timeline, then replace pendingBattery(...) with real
// `active` cases (see create-or-load-brief.ts / plan-shots.ts).
export const critiqueTimelineBattery: ToolBattery = pendingBattery(
  "critique_timeline",
  "Review the assembled timeline and list targeted fixes."
);
