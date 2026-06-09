import type { StepProps } from "../useStudioFlow";
import { StepShell } from "./StepShell";

export function ReviewStep({ next, back }: StepProps) {
  return (
    <StepShell
      heading="Review & edit"
      description="Watch the rough cut, tweak scenes, and request changes once generation completes."
      onNext={next}
      nextLabel="Continue to export"
      onBack={back}
    />
  );
}
