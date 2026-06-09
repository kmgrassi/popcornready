// Maps the engine's GenerationStageType vocabulary onto the calm, human
// checklist the `generating` state shows.
//
// Several stage types collapse onto one human step (storyboard +
// asset_generation → "Selecting clips"; quality_review + export → "Generating
// preview"), so the checklist stays short and reassuring.

import type {
  GenerationRun,
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

export interface StudioChecklistItem extends ChecklistItem {
  stages: GenerationStage[];
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

export function describeStatus(status: GenerationRunStatus): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "running":
      return "In progress";
    case "succeeded":
      return "Done";
    case "failed":
      return "Failed";
    case "canceled":
      return "Canceled";
  }
}

/**
 * Build checklist items from the run's reported stages. Data-driven: it only
 * reflects stages the run actually reports, so a future conditional stage
 * (e.g. a character anchor reported by the engine) surfaces through its stage
 * label/detail with no character-specific UI.
 * When the run reports no stages yet (just queued), the steps read as pending
 * with the first one active so the screen never looks stalled.
 */
export function buildChecklistItems(
  stages: GenerationStage[],
  runStatus: GenerationRunStatus,
  run?: GenerationRun,
): StudioChecklistItem[] {
  const orderedStages = [...stages].sort((a, b) => a.order - b.order);

  let firstUnresolved = true;
  return CHECKLIST_STEPS.map((stepDef): StudioChecklistItem => {
    const backing = orderedStages.filter((stage) =>
      stepDef.stageTypes.includes(stage.type),
    );

    let status: ChecklistStatus;
    if (stepDef.id === "ready" && runStatus === "succeeded") {
      status = "done";
    } else if (backing.length === 0) {
      // No stage reported for this step yet. While the run is still active,
      // mark the earliest unresolved step as active so progress reads forward.
      const runActive = runStatus === "queued" || runStatus === "running";
      if (runStatus === "failed" && firstUnresolved) {
        status = "failed";
      } else {
        status = runActive && firstUnresolved ? "active" : "pending";
      }
    } else if (backing.some((s) => s.status === "failed")) {
      status = "failed";
    } else if (backing.every((s) => s.status === "succeeded")) {
      status = "done";
    } else if (
      backing.some((s) => s.status === "running") ||
      backing.some((s) => s.type === run?.currentStageType) ||
      backing.some((s) => s.stageId === run?.reviewGate?.stageId)
    ) {
      status = "active";
    } else {
      status = statusFromStage(backing[0].status);
    }

    if (status !== "done") firstUnresolved = false;
    return {
      id: stepDef.id,
      label: stepDef.label,
      status,
      stages: backing,
      detail: backing.length > 0 ? undefined : "Waiting for the run to report this stage.",
    };
  });
}
