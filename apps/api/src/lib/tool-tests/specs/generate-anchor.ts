import type { ToolBattery } from "../types";
import { pendingBattery } from "./_pending";

// TODO: wire generate_anchor, then replace pendingBattery(...) with real
// `active` cases (see create-or-load-brief.ts / plan-shots.ts).
export const generateAnchorBattery: ToolBattery = pendingBattery(
  "generate_anchor",
  "Generate the reusable visual anchor for the lead character."
);
