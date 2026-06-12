import type { ReactNode } from "react";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import styles from "./StepShell.module.css";

export interface StepShellProps {
  heading: string;
  /** Short line under the heading describing the step. */
  description?: string;
  /** Which wave-3 PR fills this step in (rendered as a placeholder note). */
  comingSoonPr?: string;
  children?: ReactNode;
  /** Continue (next) handler; omit to hide the Continue button. */
  onNext?: () => void;
  /** Back handler; omit to hide the Back button (e.g. the first step). */
  onBack?: () => void;
  /** Override the Continue label (e.g. the Generate step). */
  nextLabel?: string;
  /** Disable the Continue button. */
  nextDisabled?: boolean;
  /** Use the prominent CTA variant for the primary action. */
  nextCta?: boolean;
  /** Let complex workflow steps use more horizontal room. */
  wide?: boolean;
}

/**
 * StepShell — the shared frame every wizard step renders inside (PR 1).
 *
 * Gives each scaffold a consistent card, heading, "lands in wave 3" note, and
 * Back/Continue footer wired to the flow. Wave-3 step PRs replace the body with
 * their real controls but keep this frame so navigation stays uniform.
 */
export function StepShell({
  heading,
  description,
  comingSoonPr,
  children,
  onNext,
  onBack,
  nextLabel = "Continue",
  nextDisabled = false,
  nextCta = false,
  wide = false,
}: StepShellProps) {
  const cardClassName = [styles.step, wide ? styles.wide : ""].filter(Boolean).join(" ");

  return (
    <Card padding="lg" elevated className={cardClassName}>
      <header className={styles.header}>
        <h2 className={styles.heading}>{heading}</h2>
        {description ? <p className={styles.description}>{description}</p> : null}
      </header>

      {children ? <div className={styles.body}>{children}</div> : null}

      {comingSoonPr ? (
        <p className={styles.note}>Fuller controls land in wave 3 ({comingSoonPr}).</p>
      ) : null}

      <footer className={styles.footer}>
        {onBack ? (
          <Button variant="secondary" onClick={onBack}>
            Back
          </Button>
        ) : (
          <span />
        )}
        {onNext ? (
          <Button
            variant={nextCta ? "cta" : "primary"}
            onClick={onNext}
            disabled={nextDisabled}
          >
            {nextLabel}
          </Button>
        ) : null}
      </footer>
    </Card>
  );
}
