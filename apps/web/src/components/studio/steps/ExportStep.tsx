import type { StepProps } from "../useStudioFlow";
import { StepShell } from "./StepShell";

/**
 * ExportStep (scaffold) — step 6. Minimal but navigable: format/caption options
 * and the final "Export" CTA wired to the export endpoint land in PR 7.
 */
export function ExportStep({ back }: StepProps) {
  return (
    <StepShell
      heading="Export"
      description="Pick a format and render the final video."
      comingSoonPr="PR 7"
      onBack={back}
    />
  );
}
