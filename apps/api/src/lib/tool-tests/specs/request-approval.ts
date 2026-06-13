import type { ToolBattery } from "../types";
import { pendingBattery } from "./_pending";

// TODO: wire request_approval, then replace pendingBattery(...) with real
// `active` cases (see create-or-load-brief.ts / plan-shots.ts).
export const requestApprovalBattery: ToolBattery = pendingBattery(
  "request_approval",
  "Create a user approval gate before the expensive render stage."
);
