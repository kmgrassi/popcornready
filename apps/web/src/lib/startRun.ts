// Create-project + start-generation-run flow, lifted out of the retired
// NewProjectPage so the Studio wizard (and later step PRs) share one working
// implementation. This is the only place that turns a BriefDraft into a live
// generation run; useStudioFlow.startGeneration() calls it.

import type {
  GateableGenerationStageType,
  VideoBriefInput,
} from "@popcorn/shared/v1/types";
import type { CompositionMode } from "@popcorn/shared/v1/types";
import { v1Api } from "./api-client";
import type { BriefDraft } from "../components/studio/useStudioFlow";

export interface StartRunResult {
  projectId: string;
  runId: string;
}

/** Derive a human project name from the brief goal when none was supplied. */
export function deriveProjectName(goal: string): string {
  const trimmed = goal.trim();
  if (!trimmed) return "Untitled cut";
  const firstSentence = trimmed.split(/[.!?]/)[0]?.trim() || trimmed;
  return firstSentence.length > 64
    ? `${firstSentence.slice(0, 61).trim()}...`
    : firstSentence;
}

/** Build the V1 brief payload the create/run endpoints expect from a draft. */
function briefInputFromDraft(draft: BriefDraft): VideoBriefInput {
  const requiredBeats = [draft.hook, draft.bigIdea]
    .map((value) => value.trim())
    .filter(Boolean);

  return {
    goal: draft.goal.trim(),
    targetLengthSec: draft.targetLengthSec,
    aspectRatio: draft.aspectRatio,
    platform: draft.platform,
    format: draft.format,
    style: draft.style,
    audience: draft.audience.trim() || undefined,
    hookQuestion: draft.hook.trim() || undefined,
    strongestVisual: draft.bestVisual.trim() || undefined,
    oneBigIdea: draft.bigIdea.trim() || undefined,
    caveat: draft.accuracyNote.trim() || undefined,
    payoff: draft.payoff.trim() || undefined,
    constraints:
      requiredBeats.length > 0 || draft.payoff.trim() || draft.callToAction.trim()
        ? {
            requiredBeats: requiredBeats.length > 0 ? requiredBeats : undefined,
            callToAction: draft.callToAction.trim() || undefined,
          }
        : undefined,
  };
}

/** Prompt-only vs. footage-backed runs map onto composition modes. */
function compositionModeFromDraft(draft: BriefDraft): CompositionMode {
  if (draft.footageChoice === "upload") {
    return draft.footageMode === "hybrid" ? "hybrid" : "asset_driven";
  }
  return "prompt_only";
}

/**
 * Create the project, kick off a prompt generation run, and return the ids the
 * shell needs to poll. Throws on any API failure or a missing run id so the
 * caller can surface the error.
 */
export async function createAndStartRun(draft: BriefDraft): Promise<StartRunResult> {
  const brief = briefInputFromDraft(draft);
  const reviewGates: GateableGenerationStageType[] = draft.reviewGates;

  const { project } = await v1Api.createProject({
    name: draft.projectName.trim() || deriveProjectName(draft.goal),
    brief,
  });

  const effectiveSeedKind =
    draft.provider === "gemini" ? "video" : draft.seedKind;

  const { runId } = await v1Api.startPromptGenerationRun(project.id, {
    brief,
    mode: compositionModeFromDraft(draft),
    allowGeneratedGapFill: true,
    provider: draft.provider,
    reviewGates,
    showCaptions: draft.showCaptions,
    seedAsset: {
      kind: effectiveSeedKind,
      provider: draft.provider,
      prompt: draft.goal.trim(),
      description: draft.goal.trim(),
      durationSec: effectiveSeedKind === "image" ? 4 : 8,
      size: draft.seedSize,
      preflightReviewIterations: 1,
    },
  });

  if (!runId) {
    throw new Error("Generation started without a run ID.");
  }

  return { projectId: project.id, runId };
}
