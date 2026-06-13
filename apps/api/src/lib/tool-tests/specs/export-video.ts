import type { ToolBattery } from "../types";
import { pendingBattery } from "./_pending";

// TODO: wire export_video, then replace pendingBattery(...) with real `active`
// cases (see create-or-load-brief.ts / plan-shots.ts).
export const exportVideoBattery: ToolBattery = pendingBattery(
  "export_video",
  "Export the approved timeline to a final video artifact."
);
