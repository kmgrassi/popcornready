import type { HTMLAttributes, ReactNode } from "react";
import styles from "./Card.module.css";

/**
 * Card — the base raised surface for the guided studio (PR 0).
 *
 * A subtle-bordered panel with token-driven padding. `padding` controls the
 * internal rhythm (the 8/12/16 section convention); `elevated` lifts the card
 * with a shadow for the active/foreground surface.
 */
export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Internal padding density. Defaults to `md` (16px). */
  padding?: "sm" | "md" | "lg";
  /** Add a drop shadow to lift the card off the page. */
  elevated?: boolean;
  children?: ReactNode;
}

export function Card({
  padding = "md",
  elevated = false,
  className,
  children,
  ...rest
}: CardProps) {
  const classes = [styles.card, styles[padding], elevated ? styles.elevated : null, className]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={classes} {...rest}>
      {children}
    </div>
  );
}
