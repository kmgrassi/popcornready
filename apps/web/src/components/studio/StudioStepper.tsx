import { Stepper } from "../ui/Stepper";
import { STUDIO_STEPS, type StudioStep } from "./useStudioFlow";

/** Human labels for the wizard steps shown in the rail. */
const STEP_LABELS: Record<StudioStep, string> = {
  brief: "Brief",
  footage: "Footage",
  story: "Story",
  generate: "Generate",
  review: "Review",
  export: "Export",
};

const STEPPER_STEPS = STUDIO_STEPS.map((id) => ({ id, label: STEP_LABELS[id] }));

export interface StudioStepperProps {
  /** The currently active step. */
  step: StudioStep;
  /** Jump to a completed/active step (steps after the active one stay inert). */
  onStepClick?: (step: StudioStep) => void;
}

/**
 * StudioStepper — thin wrapper over the PR 0 `Stepper` that translates the
 * `StudioStep` vocabulary into the presentational step list. Keeps the step
 * labels in one place so steps stay consistent across the shell.
 */
export function StudioStepper({ step, onStepClick }: StudioStepperProps) {
  const activeIndex = STUDIO_STEPS.indexOf(step);
  return (
    <Stepper
      steps={STEPPER_STEPS}
      activeIndex={activeIndex}
      onStepClick={
        onStepClick
          ? (index) => onStepClick(STUDIO_STEPS[index])
          : undefined
      }
    />
  );
}
