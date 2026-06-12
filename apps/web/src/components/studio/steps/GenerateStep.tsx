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
  /** Jumps back to the editable brief fields from the generate summary. */
  onEditBrief: () => void;
  /** Surfaced when the last start attempt failed. */
  error?: string;
  /** Optional panel key the route/palette should open by default. */
  openPanel?: string;
}

/**
 * GenerateStep — step 4. The one scaffold that's wired live: clicking
 * "Generate rough cut" calls `flow.startGeneration()` so the shell can run
 * end-to-end (the calm checklist + review-gate config disclosure land in PR 4).
 */
export function GenerateStep({
  draft,
  update,
  onGenerate,
  onEditBrief,
  error,
  back,
  openPanel,
}: GenerateStepProps) {
  const [submitting, setSubmitting] = useState(false);
  const [goalExpanded, setGoalExpanded] = useState(false);
  const goal = draft.goal.trim();

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

  function toggleReviewGate(stage: GateableGenerationStageType) {
    update({
      reviewGates: draft.reviewGates.includes(stage)
        ? draft.reviewGates.filter((candidate) => candidate !== stage)
        : [...draft.reviewGates, stage],
    });
  }

  return (
    <StepShell
      heading="Generate rough cut"
      description="Hand the brief to the generation engine. We'll plan the story, select clips, and assemble an editable timeline."
      comingSoonPr="PR 4"
      onBack={back}
      onNext={generate}
      nextLabel={submitting ? "Starting run..." : "Start generating"}
      nextDisabled={!draft.goal.trim() || submitting}
      nextCta
    >
      <div className={styles.summary}>
        <div className={styles.summaryItem}>
          <div className={styles.summaryHeading}>
            <span>Goal</span>
            <button className={styles.editButton} type="button" onClick={onEditBrief}>
              Edit
            </button>
          </div>
          <button
            className={`${styles.goalText} ${goalExpanded ? styles.goalTextExpanded : ""}`}
            type="button"
            aria-expanded={goalExpanded}
            onClick={() => setGoalExpanded((expanded) => !expanded)}
          >
            {goal || "—"}
          </button>
        </div>
        <div className={styles.summaryItem}>
          <span>Format</span>
          <strong>
            {draft.aspectRatio}, {draft.targetLengthSec}s
          </strong>
        </div>
        <div className={styles.summaryItem}>
          <span>Source</span>
          <strong>{draft.footageChoice === "upload" ? "Your footage" : "Prompt only"}</strong>
        </div>
      </div>
      <aside className={styles.nextStep} aria-label="What happens next">
        <span className={styles.nextStepIcon} aria-hidden="true">
          i
        </span>
        <div>
          <h3>What happens when you start?</h3>
          <p>
            We'll create the project, generate or select media, assemble an editable
            rough cut, then take you to Review when it's ready.
          </p>
        </div>
      </aside>
      <Disclosure
        className={styles.config}
        summary="Generation options"
        defaultOpen={openPanel === "generation"}
      >
        <div className={styles.configGrid}>
          <fieldset className={styles.group}>
            <legend className={styles.legend}>Captions</legend>
            <label
              className={`${styles.checkboxCard} ${
                draft.showCaptions ? styles.checkboxCardChecked : ""
              }`}
            >
              <input
                className={styles.checkboxInput}
                type="checkbox"
                checked={draft.showCaptions}
                onChange={(event) => update({ showCaptions: event.target.checked })}
              />
              <span className={styles.checkboxCopy}>
                <strong>Generate captions</strong>
                <small>Include caption text in the generated timeline.</small>
              </span>
            </label>
          </fieldset>

          <fieldset className={styles.group}>
            <legend className={styles.legend}>Review gates</legend>
            <p className={styles.help}>
              Pause before expensive stages when you want to approve the work.
            </p>
            <ol className={styles.gateSequence}>
              {GATEABLE_GENERATION_STAGE_TYPES.map((stage) => {
                const checked = draft.reviewGates.includes(stage);

                return (
                  <li className={styles.gateStep} key={stage}>
                    <label
                      className={`${styles.checkboxCard} ${
                        checked ? styles.checkboxCardChecked : ""
                      }`}
                    >
                      <input
                        className={styles.checkboxInput}
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleReviewGate(stage)}
                      />
                      <span className={styles.checkboxCopy}>
                        <strong>{GENERATION_STAGE_LABELS[stage]}</strong>
                        <small>Ask before continuing past this stage.</small>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ol>
          </fieldset>
        </div>
      </Disclosure>
      {error ? <p className="new-project-error">{error}</p> : null}
    </StepShell>
  );
}
