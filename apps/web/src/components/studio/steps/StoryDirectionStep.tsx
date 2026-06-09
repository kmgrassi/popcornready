import type { StepProps } from "../useStudioFlow";
import { StepShell } from "./StepShell";

/**
 * StoryDirectionStep (scaffold) — step 3. Minimal but navigable: the dedicated
 * story knobs (format + hook) land in PR 3. Navigable through to Generate.
 */
export function StoryDirectionStep({ next, back }: StepProps) {
  return (
    <StepShell
      heading="Story direction"
      description="A couple of creative knobs worth a dedicated step — format and the opening hook."
      comingSoonPr="PR 3"
      onNext={next}
      onBack={back}
    />
  );
}
