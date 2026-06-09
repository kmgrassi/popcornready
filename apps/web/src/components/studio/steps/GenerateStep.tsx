import { useState } from "react";
import type { StepProps } from "../useStudioFlow";
import { StepShell } from "./StepShell";

export interface GenerateStepProps extends StepProps {
  /** Kicks the create-project + start-run flow on the shell's StudioFlow. */
  onGenerate: () => Promise<void>;
  /** Surfaced when the last start attempt failed. */
  error?: string;
}

/**
 * GenerateStep — step 4. The one scaffold that's wired live: clicking
 * "Generate rough cut" calls `flow.startGeneration()` so the shell can run
 * end-to-end (the calm checklist + review-gate config disclosure land in PR 4).
 */
export function GenerateStep({ draft, onGenerate, error, back }: GenerateStepProps) {
  const [submitting, setSubmitting] = useState(false);

  async function generate() {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onGenerate();
    } catch {
      // Error is surfaced via the `error` prop from the flow.
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <StepShell
      heading="Generate rough cut"
      description="Hand the brief to the generation engine. We'll plan the story, select clips, and assemble an editable timeline."
      comingSoonPr="PR 4"
      onBack={back}
      onNext={generate}
      nextLabel={submitting ? "Starting run..." : "Generate rough cut"}
      nextDisabled={!draft.goal.trim() || submitting}
      nextCta
    >
      <div className="new-project-summary">
        <div>
          <span>Goal</span>
          <strong>{draft.goal.trim() || "—"}</strong>
        </div>
        <div>
          <span>Format</span>
          <strong>
            {draft.aspectRatio}, {draft.targetLengthSec}s
          </strong>
        </div>
        <div>
          <span>Source</span>
          <strong>{draft.footageChoice === "upload" ? "Your footage" : "Prompt only"}</strong>
        </div>
      </div>
      {error ? <p className="new-project-error">{error}</p> : null}
    </StepShell>
  );
}
