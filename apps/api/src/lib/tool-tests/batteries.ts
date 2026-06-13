// Mount point: aggregates every per-tool battery into one lookup. Add a new
// tool's spec import here. A startup check asserts all 14 vocabulary tools have
// a battery so a newly-declared tool can't silently lack test coverage.

import { TOOL_NAMES, type ToolName } from "@/lib/orchestrator";
import type { ToolBattery } from "./types";

import { assembleTimelineBattery } from "./specs/assemble-timeline";
import { createOrLoadBriefBattery } from "./specs/create-or-load-brief";
import { critiqueTimelineBattery } from "./specs/critique-timeline";
import { developStoryBlueprintBattery } from "./specs/develop-story-blueprint";
import { draftScriptBattery } from "./specs/draft-script";
import { exportVideoBattery } from "./specs/export-video";
import { generateAnchorBattery } from "./specs/generate-anchor";
import { generateAudioBattery } from "./specs/generate-audio";
import { generateClipBattery } from "./specs/generate-clip";
import { generateKeyframeBattery } from "./specs/generate-keyframe";
import { generateStoryboardBattery } from "./specs/generate-storyboard";
import { planShotsBattery } from "./specs/plan-shots";
import { planVisualAnchorsBattery } from "./specs/plan-visual-anchors";
import { requestApprovalBattery } from "./specs/request-approval";

const ALL_BATTERIES: ToolBattery[] = [
  createOrLoadBriefBattery,
  developStoryBlueprintBattery,
  draftScriptBattery,
  planShotsBattery,
  planVisualAnchorsBattery,
  generateAnchorBattery,
  generateStoryboardBattery,
  generateKeyframeBattery,
  generateClipBattery,
  generateAudioBattery,
  assembleTimelineBattery,
  critiqueTimelineBattery,
  requestApprovalBattery,
  exportVideoBattery,
];

export const batteries: Map<ToolName, ToolBattery> = new Map(
  ALL_BATTERIES.map((battery) => [battery.tool, battery])
);

// Fail loud if a vocabulary tool has no battery (or a battery names an unknown
// tool) — keeps the harness honest as the vocabulary grows.
const missing = TOOL_NAMES.filter((name) => !batteries.has(name));
if (missing.length > 0) {
  throw new Error(`Tool-test batteries missing for: ${missing.join(", ")}`);
}
if (batteries.size !== TOOL_NAMES.length) {
  throw new Error(
    `Tool-test batteries define ${batteries.size} tools but the vocabulary has ${TOOL_NAMES.length}.`
  );
}

export function listBatteries(): ToolBattery[] {
  return [...batteries.values()];
}

export function getBattery(tool: ToolName): ToolBattery | undefined {
  return batteries.get(tool);
}
