import styles from "./Stepper.module.css";

/** A single step in the {@link Stepper}. */
export interface Step {
  /** Stable id (e.g. the StudioStep key); used as the React key. */
  id: string;
  /** Short human label shown next to the step index. */
  label: string;
}

export interface StepperProps {
  /** Ordered list of steps to render. */
  steps: Step[];
  /** Index of the currently active step. Steps before it read as complete. */
  activeIndex: number;
  /**
   * Optional click handler. When provided, completed/active steps become
   * buttons so the user can jump back. Steps after the active one stay inert.
   */
  onStepClick?: (index: number, step: Step) => void;
  /**
   * Highest step index that should be clickable. Defaults to the active index,
   * which preserves the usual "jump back only" behavior.
   */
  clickableThroughIndex?: number;
  className?: string;
}

/**
 * Stepper — the guided-studio progress rail (PR 0).
 *
 * Renders an ordered list of steps with the active one highlighted and prior
 * steps marked complete. Purely presentational: the active step and any
 * navigation are owned by the caller (the Studio flow machine).
 */
export function Stepper({
  steps,
  activeIndex,
  onStepClick,
  clickableThroughIndex = activeIndex,
  className,
}: StepperProps) {
  const classes = [styles.stepper, className].filter(Boolean).join(" ");
  return (
    <ol className={classes}>
      {steps.map((step, index) => {
        const status =
          index < activeIndex ? "done" : index === activeIndex ? "active" : "upcoming";
        const interactive = Boolean(onStepClick) && index <= clickableThroughIndex;
        const content = (
          <>
            <span className={styles.marker} aria-hidden="true">
              {status === "done" ? "✓" : index + 1}
            </span>
            <span className={styles.label}>{step.label}</span>
          </>
        );
        return (
          <li
            key={step.id}
            className={[styles.step, styles[status]].join(" ")}
            aria-current={status === "active" ? "step" : undefined}
          >
            {interactive ? (
              <button
                type="button"
                className={styles.trigger}
                onClick={() => onStepClick?.(index, step)}
              >
                {content}
              </button>
            ) : (
              <span className={styles.trigger}>{content}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
