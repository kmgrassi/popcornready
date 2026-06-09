// Maps the engine's GenerationStageType vocabulary onto the calm, human
// checklist the `generating` state shows. PR 4 enriches this (per-item detail,
// conditional anchor stage); this is the working baseline.
//
// Several stage types collapse onto one human step (storyboard +
// asset_generation → "Selecting clips"; quality_review + export → "Generating
// preview"), so the checklist stays short and reassuring.

import type {
  GenerationRunStatus,
  GenerationStage,
  GenerationStageType,
} from "@popcorn/shared/v1/types";
import type { ChecklistItem, ChecklistStatus } from "../ui/StatusChecklist";

/** Ordered human checklist steps, each backed by one or more stage types. */
interface ChecklistStepDef {
  id: string;
  label: string;
  stageTypes: GenerationStageType[];
}

export const CHECKLIST_STEPS: ChecklistStepDef[] = [
  { id: "planning", label: "Planning story structure", stageTypes: ["brief_intake", "creative_plan"] },
  { id: "clips", label: "Selecting clips", stageTypes: ["storyboard", "asset_generation", "audio_generation"] },
  { id: "timeline", label: "Building timeline", stageTypes: ["timeline_assembly"] },
  { id: "preview", label: "Generating preview", stageTypes: ["quality_review", "export"] },
  { id: "ready", label: "Ready for review", stageTypes: ["ready"] },
];

/** Map a single backing stage's run status onto a checklist lifecycle status. */
function statusFromStage(status: GenerationRunStatus): ChecklistStatus {
  switch (status) {
    case "succeeded":
      return "done";
    case "running":
      return "active";
    case "failed":
      return "failed";
    default:
      return "pending";
  }
}

/**
 * Build checklist items from the run's reported stages. Data-driven: it only
 * reflects stages the run actually reports, so a future conditional stage
 * (e.g. a character anchor) surfaces under "Selecting clips" with no extra UI.
 * When the run reports no stages yet (just queued), the steps read as pending
 * with the first one active so the screen never looks stalled.
 */
export function buildChecklistItems(
  stages: GenerationStage[],
  runStatus: GenerationRunStatus,
): ChecklistItem[] {
  const byType = new Map<GenerationStageType, GenerationStage>();
  for (const stage of stages) byType.set(stage.type, stage);

  let firstUnresolved = true;
  return CHECKLIST_STEPS.map((stepDef): ChecklistItem => {
    const backing = stepDef.stageTypes
      .map((type) => byType.get(type))
      .filter((stage): stage is GenerationStage => Boolean(stage));

    let status: ChecklistStatus;
    if (backing.length === 0) {
      // No stage reported for this step yet. While the run is still active,
      // mark the earliest unresolved step as active so progress reads forward.
      const runActive = runStatus === "queued" || runStatus === "running";
      status = runActive && firstUnresolved ? "active" : "pending";
    } else if (backing.some((s) => s.status === "failed")) {
      status = "failed";
    } else if (backing.every((s) => s.status === "succeeded")) {
      status = "done";
    } else if (backing.some((s) => s.status === "running")) {
      status = "active";
    } else {
      status = statusFromStage(backing[0].status);
    }

    if (status !== "done") firstUnresolved = false;
    return { id: stepDef.id, label: stepDef.label, status };
  });
}
