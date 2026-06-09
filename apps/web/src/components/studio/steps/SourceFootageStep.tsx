import type { StepProps } from "../useStudioFlow";
import { StepShell } from "./StepShell";

/**
 * SourceFootageStep (scaffold) — step 2. Minimal but navigable: the full
 * upload vs. prompt-only vs. footage-edit UI (consuming `lib/upload.ts`) lands
 * in PR 3. A prompt-only / upload toggle is wired so the choice flows through.
 */
export function SourceFootageStep({ draft, update, next, back }: StepProps) {
  return (
    <StepShell
      heading="How should we use your footage?"
      description="Generate everything from your brief, or bring your own clips for us to cut."
      comingSoonPr="PR 3"
      onNext={next}
      onBack={back}
    >
      <label className="inline-check">
        <input
          type="radio"
          name="footage-choice"
          checked={draft.footageChoice === "prompt_only"}
          onChange={() => update({ footageChoice: "prompt_only" })}
        />
        Prompt only — generate all visuals
      </label>
      <label className="inline-check">
        <input
          type="radio"
          name="footage-choice"
          checked={draft.footageChoice === "upload"}
          onChange={() => update({ footageChoice: "upload" })}
        />
        Use my footage
      </label>
    </StepShell>
  );
}
