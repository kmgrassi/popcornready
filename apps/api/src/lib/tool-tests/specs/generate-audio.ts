import type { ToolBattery } from "../types";
import { pendingBattery } from "./_pending";

// TODO: wire generate_audio, then replace pendingBattery(...) with real `active`
// cases (see create-or-load-brief.ts / plan-shots.ts).
export const generateAudioBattery: ToolBattery = pendingBattery(
  "generate_audio",
  "Generate the narration audio for the script."
);
