import type { StepProps } from "../useStudioFlow";
import { StepShell } from "./StepShell";

/**
 * BriefStep (scaffold) — step 1. Minimal but navigable: the real <5-control
 * brief + "Advanced creative direction" disclosure land in PR 2. A single
 * goal field is wired here so the shell is demoable end-to-end.
 */
export function BriefStep({ draft, update, next }: StepProps) {
  return (
    <StepShell
      heading="What should this video do?"
      description="Describe the video you want. We'll plan the story, pick the shots, and assemble a rough cut."
      comingSoonPr="PR 2"
      onNext={next}
      nextDisabled={!draft.goal.trim()}
    >
      <label className="muted">Creative goal</label>
      <textarea
        value={draft.goal}
        rows={5}
        placeholder="e.g. A 30s ad that hooks fast, shows the problem, demos the product, and ends with a strong CTA."
        onChange={(event) => update({ goal: event.target.value })}
      />
    </StepShell>
  );
}
