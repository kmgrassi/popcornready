import type { ReactNode } from "react";
import styles from "./StatusChecklist.module.css";

/** Lifecycle status of a single checklist item. */
export type ChecklistStatus = "pending" | "active" | "done" | "failed";

export interface ChecklistItem {
  /** Stable id (used as the React key). */
  id: string;
  /** Human label, e.g. "Planning story structure". */
  label: string;
  status: ChecklistStatus;
  /** Optional secondary line under the label (e.g. progress detail). */
  detail?: ReactNode;
}

export interface StatusChecklistProps {
  /** Ordered items to render top-to-bottom. */
  items: ChecklistItem[];
  className?: string;
}

const STATUS_MARK: Record<ChecklistStatus, string> = {
  pending: "",
  active: "",
  done: "✓",
  failed: "!",
};

/** Spoken status, so assistive tech conveys the same lifecycle the color/icon does. */
const STATUS_LABEL: Record<ChecklistStatus, string> = {
  pending: "Not started",
  active: "In progress",
  done: "Done",
  failed: "Failed",
};

/**
 * StatusChecklist — a calm vertical progress list (PR 0).
 *
 * Each item shows a status dot + label: pending (quiet), active (spinner-style
 * pulse), done (green check), failed (danger). The generation checklist (PR 4)
 * is data-driven — it renders whatever items the run reports — so this stays a
 * dumb presentational list with no domain knowledge.
 */
export function StatusChecklist({ items, className }: StatusChecklistProps) {
  return (
    <ul className={[styles.list, className].filter(Boolean).join(" ")}>
      {items.map((item) => (
        <li
          key={item.id}
          className={[styles.item, styles[item.status]].join(" ")}
          aria-current={item.status === "active" ? "step" : undefined}
        >
          <span className={styles.marker} aria-hidden="true">
            {STATUS_MARK[item.status]}
          </span>
          <span className={styles.body}>
            <span className={styles.label}>{item.label}</span>
            {/* Programmatic status — visually hidden, but announced by screen
                readers since the marker icon/color is aria-hidden. */}
            <span className={styles.srOnly}>{STATUS_LABEL[item.status]}</span>
            {item.detail ? <span className={styles.detail}>{item.detail}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
