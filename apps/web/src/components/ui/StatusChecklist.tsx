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
        <li key={item.id} className={[styles.item, styles[item.status]].join(" ")}>
          <span className={styles.marker} aria-hidden="true">
            {STATUS_MARK[item.status]}
          </span>
          <span className={styles.body}>
            <span className={styles.label}>{item.label}</span>
            {item.detail ? <span className={styles.detail}>{item.detail}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
