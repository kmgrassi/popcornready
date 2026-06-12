import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import styles from "./Stack.module.css";

type Space = "none" | "xs" | "sm" | "md" | "lg" | "xl";
type Align = "start" | "center" | "end" | "stretch";
type Justify = "start" | "center" | "end" | "between";

interface LayoutProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  gap?: Space;
  align?: Align;
  justify?: Justify;
}

function layoutClass(
  baseClass: string,
  { gap = "md", align = "stretch", justify = "start", className }: Omit<LayoutProps, "children">
) {
  return [
    baseClass,
    styles[`gap-${gap}`],
    styles[`align-${align}`],
    styles[`justify-${justify}`],
    className,
  ]
    .filter(Boolean)
    .join(" ");
}

export function Stack({ children, gap, align, justify, className, ...rest }: LayoutProps) {
  return (
    <div className={layoutClass(styles.stack, { gap, align, justify, className })} {...rest}>
      {children}
    </div>
  );
}

export function Inline({
  children,
  gap,
  align = "center",
  justify,
  className,
  ...rest
}: LayoutProps) {
  return (
    <div className={layoutClass(styles.inline, { gap, align, justify, className })} {...rest}>
      {children}
    </div>
  );
}

interface BoxProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  padding?: Space;
}

const PADDING: Record<Space, string> = {
  none: "0",
  xs: "var(--space-1)",
  sm: "var(--space-2)",
  md: "var(--space-3)",
  lg: "var(--space-4)",
  xl: "var(--space-6)",
};

export function Box({ children, padding = "md", className, style, ...rest }: BoxProps) {
  return (
    <div
      className={[styles.box, className].filter(Boolean).join(" ")}
      style={{ "--box-padding": PADDING[padding], ...style } as CSSProperties}
      {...rest}
    >
      {children}
    </div>
  );
}
