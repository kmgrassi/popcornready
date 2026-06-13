import type { ToolBattery } from "../types";
import { pendingBattery } from "./_pending";

// TODO: wire assemble_timeline, then replace pendingBattery(...) with real
// `active` cases (see create-or-load-brief.ts / plan-shots.ts).
export const assembleTimelineBattery: ToolBattery = pendingBattery(
  "assemble_timeline",
  "Assemble the generated assets into a deterministic timeline."
);
