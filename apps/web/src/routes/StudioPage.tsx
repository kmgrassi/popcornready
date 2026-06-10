import { useSearchParams } from "react-router-dom";
import {
  GATEABLE_GENERATION_STAGE_TYPES,
  type GateableGenerationStageType,
} from "@popcorn/shared/v1/types";
import { StudioShell } from "../components/studio/StudioShell";
import type { BriefDraft, StudioStep } from "../components/studio/useStudioFlow";

const STUDIO_STEP_SET = new Set<StudioStep>([
  "brief",
  "footage",
  "story",
  "generate",
  "review",
  "export",
]);

function parseStudioStep(value: string | null): StudioStep | undefined {
  return STUDIO_STEP_SET.has(value as StudioStep)
    ? (value as StudioStep)
    : undefined;
}

function parseReviewGates(value: string | null): GateableGenerationStageType[] {
  if (!value) return [];
  const validStages = new Set<string>(GATEABLE_GENERATION_STAGE_TYPES);
  return value
    .split(",")
    .filter((stage): stage is GateableGenerationStageType => validStages.has(stage));
}

/**
 * StudioPage — the single guided wizard surface. Renders the StudioShell, which
 * owns the `initial → generating → review` state machine. Any `?goal=`/`?length=`
 * query params (e.g. from Home CTAs) seed the brief draft.
 */
export function StudioPage() {
  const [params] = useSearchParams();
  const goal = params.get("goal") ?? "";
  const length = Number(params.get("length"));
  const initialStep = parseStudioStep(params.get("step"));
  const openPanel = params.get("panel") ?? undefined;
  const reviewGates = parseReviewGates(params.get("reviewGates"));

  const initialBrief: Partial<BriefDraft> = {
    ...(goal ? { goal } : {}),
    ...(Number.isFinite(length) && length > 0 ? { targetLengthSec: length } : {}),
    ...(reviewGates.length > 0 ? { reviewGates } : {}),
  };

  return (
    <StudioShell
      initialBrief={initialBrief}
      initialStep={initialStep}
      initialStarted={params.has("start") || Boolean(initialStep || goal)}
      openPanel={openPanel}
    />
  );
}
