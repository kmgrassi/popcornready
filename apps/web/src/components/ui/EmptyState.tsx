import type { ReactNode } from "react";
import styles from "./EmptyState.module.css";

export interface EmptyStateProps {
  /** Large page-title headline explaining the state (uses --title-xl). */
  headline: string;
  /** Supporting copy describing what happens next. */
  supporting?: string;
  /** Optional illustration / icon rendered above the headline. */
  icon?: ReactNode;
  /** CTA slot — typically a single prominent <Button variant="cta">. */
  action?: ReactNode;
  className?: string;
}

/**
 * EmptyState — the guided-studio zero state (PR 0).
 *
 * A centered headline + supporting text + CTA slot used when there's nothing to
 * show yet (e.g. before the first rough cut). The headline uses the larger
 * page-title scale so the next action is obvious within seconds.
 *
 * Note: this is the studio empty state. The dense `EmptyState` in `StateCard.tsx`
 * is a separate dashboard-list primitive — import this one from
 * `components/ui/EmptyState`.
 */
export function EmptyState({ headline, supporting, icon, action, className }: EmptyStateProps) {
  return (
    <div className={[styles.empty, className].filter(Boolean).join(" ")}>
      {icon ? <div className={styles.icon}>{icon}</div> : null}
      <h2 className={styles.headline}>{headline}</h2>
      {supporting ? <p className={styles.supporting}>{supporting}</p> : null}
      {action ? <div className={styles.action}>{action}</div> : null}
    </div>
  );
}
