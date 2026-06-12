import { useState } from "react";
import {
  GATEABLE_GENERATION_STAGE_TYPES,
  GENERATION_STAGE_LABELS,
  type GateableGenerationStageType,
} from "@popcorn/shared/v1/types";
import type { StepProps } from "../useStudioFlow";
import { StepShell } from "./StepShell";
import styles from "./GenerateStep.module.css";

const CHECKPOINT_DESCRIPTIONS: Record<GateableGenerationStageType, string> = {
  brief_intake:
    "The agent turns your prompt, format, footage choice, and creative direction into a clean working brief.",
  creative_plan:
    "The agent decides the story structure: hook, beats, pacing, and the intended viewer takeaway.",
  storyboard:
    "The agent sketches the visual sequence before generating full media, so you can review the shape early.",
  asset_generation:
    "The agent generates or selects the visuals needed for each beat in the plan.",
  audio_generation:
    "The agent creates or selects narration, dialogue, music, or sound when the cut needs audio.",
  timeline_assembly:
    "The agent places media, captions, and timing into an editable rough-cut timeline.",
  quality_review:
    "The agent checks the cut for coherence, pacing, and obvious issues before handing it back.",
  export:
    "The app renders the finished timeline into a reviewable video file.",
};

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
 * GenerateStep — step 4. The handoff controls for how autonomous the run should
 * be before the user reviews generated work.
 */
export function GenerateStep({
  draft,
  update,
  onGenerate,
  onEditBrief,
  error,
  back,
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
      heading="Set checkpoints"
      description="Choose where the agent should pause for approval before it keeps working."
      comingSoonPr="PR 4"
      onBack={back}
      onNext={generate}
      nextLabel={submitting ? "Starting run..." : "Start generating"}
      nextDisabled={!draft.goal.trim() || submitting}
      nextCta
    >
      <section className={styles.summarySection} aria-labelledby="checkpoint-summary-heading">
        <div>
          <h3 id="checkpoint-summary-heading" className={styles.sectionTitle}>
            Run summary
          </h3>
          <p className={styles.sectionHelp}>
            Confirm the brief the agent will use before it starts generating.
          </p>
        </div>
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
      </section>
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
      <fieldset className={styles.group}>
        <legend className={styles.legend}>Review checkpoints</legend>
        <p className={styles.help}>
          Select the stages where the run should stop and wait for your approval.
          Leave all unchecked for a fully automatic rough cut.
        </p>
        <ol className={styles.gateSequence}>
          {GATEABLE_GENERATION_STAGE_TYPES.map((stage) => {
            const checked = draft.reviewGates.includes(stage);
            const description = CHECKPOINT_DESCRIPTIONS[stage];
            const tooltipId = `checkpoint-${stage}-description`;

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
                    <span className={styles.checkpointTitleRow}>
                      <strong>{GENERATION_STAGE_LABELS[stage]}</strong>
                      <span
                        className={styles.infoBadge}
                        role="img"
                        tabIndex={0}
                        aria-label={`${GENERATION_STAGE_LABELS[stage]} info`}
                        aria-describedby={tooltipId}
                        title={description}
                      >
                        i
                      </span>
                      <span id={tooltipId} className={styles.tooltip} role="tooltip">
                        {description}
                      </span>
                    </span>
                    <small>Pause here so you can approve or request changes.</small>
                  </span>
                </label>
              </li>
            );
          })}
        </ol>
      </fieldset>
      {error ? <p className="new-project-error">{error}</p> : null}
    </StepShell>
  );
}
