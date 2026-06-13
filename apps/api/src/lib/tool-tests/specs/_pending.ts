import type { ToolName } from "@/lib/orchestrator";
import type { ToolBattery } from "../types";

// Placeholder battery for a tool that has no live handler yet. The single case
// is `pending` (the runner skips it). When the tool is wired, replace the
// pendingBattery(...) call in that tool's spec file with real `active` cases —
// see create-or-load-brief.ts and plan-shots.ts for the shape.
export function pendingBattery(tool: ToolName, instruction: string): ToolBattery {
  return {
    tool,
    cases: [
      {
        name: "pending — tool not wired",
        instruction,
        status: "pending",
        expect: { tool },
      },
    ],
  };
}
