import type { ToolBattery } from "../types";
import { pendingBattery } from "./_pending";

// TODO: wire draft_script, then replace pendingBattery(...) with real `active`
// cases (see create-or-load-brief.ts / plan-shots.ts).
export const draftScriptBattery: ToolBattery = pendingBattery(
  "draft_script",
  "Draft the narration and on-screen copy for the planned scenes."
);
