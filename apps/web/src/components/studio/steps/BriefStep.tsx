import type { StepProps } from "../useStudioFlow";
import { AdvancedDirection } from "../AdvancedDirection";
import { aspectOptions, lengthOptions, studioCopy } from "../copy";
import { StepShell } from "./StepShell";
import styles from "./BriefStep.module.css";

export function BriefStep({ draft, update, next }: StepProps) {
  return (
    <StepShell
      heading={studioCopy.brief.heading}
      description={studioCopy.brief.description}
      onNext={next}
      nextCta
      nextDisabled={!draft.goal.trim()}
    >
      <div className={styles.form}>
        <label className={styles.field}>
          <span className={styles.label}>{studioCopy.brief.goalLabel}</span>
          <textarea
            className={styles.goal}
            value={draft.goal}
            placeholder={studioCopy.brief.goalPlaceholder}
            onChange={(event) => update({ goal: event.target.value })}
          />
        </label>

        <div className={styles.optionGroups}>
          <fieldset className={styles.field}>
            <legend className={styles.label}>{studioCopy.brief.lengthLabel}</legend>
            <div className={styles.segmented}>
              {lengthOptions.map((option) => (
                <label className={styles.option} key={option.value}>
                  <input
                    className={styles.optionInput}
                    type="radio"
                    name="brief-length"
                    checked={draft.targetLengthSec === option.value}
                    onChange={() => update({ targetLengthSec: option.value })}
                  />
                  <span className={styles.optionLabel}>{option.label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className={styles.field}>
            <legend className={styles.label}>{studioCopy.brief.aspectLabel}</legend>
            <div className={styles.segmented}>
              {aspectOptions.map((option) => (
                <label className={styles.option} key={option.value}>
                  <input
                    className={styles.optionInput}
                    type="radio"
                    name="brief-aspect"
                    checked={draft.aspectRatio === option.value}
                    onChange={() => update({ aspectRatio: option.value })}
                  />
                  <span className={styles.optionLabel}>{option.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        <AdvancedDirection draft={draft} update={update} />
      </div>
    </StepShell>
  );
}
