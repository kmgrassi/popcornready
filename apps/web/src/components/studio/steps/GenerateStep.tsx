import { useState } from "react";
import {
  GATEABLE_GENERATION_STAGE_TYPES,
  GENERATION_STAGE_LABELS,
  type GateableGenerationStageType,
} from "@popcorn/shared/v1/types";
import { Disclosure } from "../../ui/Disclosure";
import type { StepProps } from "../useStudioFlow";
import { StepShell } from "./StepShell";
import styles from "./GenerateStep.module.css";

export interface GenerateStepProps extends StepProps {
  /** Kicks the create-project + start-run flow on the shell's StudioFlow. */
  onGenerate: () => Promise<void>;
  /** Surfaced when the last start attempt failed. */
  error?: string;
}

/**
 * GenerateStep — step 4. Clicking "Generate rough cut" calls
 * `flow.startGeneration()`, then the shell swaps this setup card for the live
 * generation checklist.
 */
export function GenerateStep({
  draft,
  update,
  onGenerate,
  error,
  back,
}: GenerateStepProps) {
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
      onBack={back}
      onNext={generate}
      nextLabel={submitting ? "Starting run..." : "Generate rough cut"}
      nextDisabled={!draft.goal.trim() || submitting}
      nextCta
    >
      <div className={styles.summary}>
        <div className={styles.summaryItem}>
          <span className={styles.summaryLabel}>Goal</span>
          <strong className={styles.summaryValue}>{draft.goal.trim() || "-"}</strong>
        </div>
        <div className={styles.summaryItem}>
          <span className={styles.summaryLabel}>Format</span>
          <strong className={styles.summaryValue}>
            {draft.aspectRatio}, {draft.targetLengthSec}s
          </strong>
        </div>
        <div className={styles.summaryItem}>
          <span className={styles.summaryLabel}>Source</span>
          <strong className={styles.summaryValue}>
            {draft.footageChoice === "upload" ? "Your footage" : "Prompt only"}
          </strong>
        </div>
      </div>
      <Disclosure summary="Advanced review pauses">
        <p className={styles.gateIntro}>
          Pause after selected stages so you can approve the output before the
          next stage starts.
        </p>
        <div className={styles.gateGrid}>
          {GATEABLE_GENERATION_STAGE_TYPES.map((stageType) => (
            <label key={stageType} className={styles.gateOption}>
              <input
                type="checkbox"
                checked={draft.reviewGates.includes(stageType)}
                onChange={(event) =>
                  update({
                    reviewGates: toggleReviewGate(
                      draft.reviewGates,
                      stageType,
                      event.target.checked,
                    ),
                  })
                }
              />
              {GENERATION_STAGE_LABELS[stageType]}
            </label>
          ))}
        </div>
      </Disclosure>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </StepShell>
  );
}

function toggleReviewGate(
  current: GateableGenerationStageType[],
  stageType: GateableGenerationStageType,
  enabled: boolean,
): GateableGenerationStageType[] {
  if (enabled) {
    return current.includes(stageType) ? current : [...current, stageType];
  }
  return current.filter((type) => type !== stageType);
}
