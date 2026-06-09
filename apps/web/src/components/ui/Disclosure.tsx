import { useId, useState, type ReactNode } from "react";
import styles from "./Disclosure.module.css";

export interface DisclosureProps {
  /** Trigger label, e.g. "Advanced creative direction". */
  summary: string;
  /** Whether the section starts open. Defaults to collapsed (PR 0 intent). */
  defaultOpen?: boolean;
  /**
   * Controlled-open value. When provided the component is controlled and the
   * caller must supply `onOpenChange`.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
  className?: string;
}

/**
 * Disclosure — a collapsed-by-default expandable section (PR 0).
 *
 * Used for progressive disclosure (e.g. "Advanced creative direction"): keeps
 * the first screen calm while making optional controls one click away. Works
 * uncontrolled by default; pass `open`/`onOpenChange` to control it.
 */
export function Disclosure({
  summary,
  defaultOpen = false,
  open,
  onOpenChange,
  children,
  className,
}: DisclosureProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isControlled = open !== undefined;
  const isOpen = isControlled ? open : internalOpen;
  const panelId = useId();

  const toggle = () => {
    const next = !isOpen;
    if (!isControlled) {
      setInternalOpen(next);
    }
    onOpenChange?.(next);
  };

  return (
    <div className={[styles.disclosure, className].filter(Boolean).join(" ")}>
      <button
        type="button"
        className={styles.trigger}
        aria-expanded={isOpen}
        aria-controls={panelId}
        onClick={toggle}
      >
        <span className={styles.summary}>{summary}</span>
        <span className={[styles.chevron, isOpen ? styles.chevronOpen : ""].join(" ")} aria-hidden="true">
          ▾
        </span>
      </button>
      {isOpen ? (
        <div className={styles.panel} id={panelId}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
