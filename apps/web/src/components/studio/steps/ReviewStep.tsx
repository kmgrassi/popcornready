import type { StepProps } from "../useStudioFlow";
import { StepShell } from "./StepShell";

/**
 * ReviewStep (scaffold) — step 5. In the live shell, the `review` state renders
 * the preview + timeline directly (interim reuse of PreviewPanel/SidebarPanel);
 * this scaffold is the navigable placeholder for the scene-notes / regenerate /
 * feedback UI that lands in PR 6. Navigable on to Export.
 */
export function ReviewStep({ next, back }: StepProps) {
  return (
    <StepShell
      heading="Review & edit"
      description="Watch the rough cut, tweak scenes, and request changes."
      comingSoonPr="PR 6"
      onNext={next}
      nextLabel="Continue to export"
      onBack={back}
    />
  );
}
