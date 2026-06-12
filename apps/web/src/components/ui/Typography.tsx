import type { HTMLAttributes, ReactNode } from "react";
import styles from "./Typography.module.css";

type HeadingLevel = 1 | 2 | 3 | 4;
type HeadingSize = "sm" | "md" | "lg" | "xl";
type TextTone = "default" | "muted" | "strong" | "danger";
type TextSize = "xs" | "sm" | "md" | "lg";

export interface HeadingProps extends HTMLAttributes<HTMLHeadingElement> {
  as?: `h${HeadingLevel}`;
  size?: HeadingSize;
  children: ReactNode;
}

export function Heading({ as: Component = "h2", size = "md", className, children, ...rest }: HeadingProps) {
  return (
    <Component className={[styles.heading, styles[`heading-${size}`], className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </Component>
  );
}

export interface TextProps extends HTMLAttributes<HTMLParagraphElement> {
  as?: "p" | "span" | "div";
  size?: TextSize;
  tone?: TextTone;
  children: ReactNode;
}

export function Text({
  as: Component = "p",
  size = "md",
  tone = "default",
  className,
  children,
  ...rest
}: TextProps) {
  return (
    <Component className={[styles.text, styles[`text-${size}`], styles[`tone-${tone}`], className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </Component>
  );
}

export function Eyebrow({ children, className, ...rest }: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={[styles.eyebrow, className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </p>
  );
}
