import type { ButtonHTMLAttributes } from "react";
import { Link, type LinkProps } from "react-router-dom";
import styles from "./Button.module.css";

// `cta` is the single prominent popcorn-yellow call-to-action (PR 0). Use it
// for the one dominant action on a screen; `primary` remains the accent fill.
export type ButtonVariant = "primary" | "secondary" | "ghost" | "cta";
export type ButtonSize = "sm" | "md" | "lg";

interface ButtonStyleProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}

function buttonClass({ variant = "primary", size = "md", className }: ButtonStyleProps) {
  return [styles.btn, styles[variant], styles[size], className]
    .filter(Boolean)
    .join(" ");
}

export function Button({
  variant,
  size,
  className,
  type = "button",
  ...rest
}: ButtonStyleProps & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type={type} className={buttonClass({ variant, size, className })} {...rest} />
  );
}

export function ButtonLink({
  variant,
  size,
  className,
  ...rest
}: ButtonStyleProps & LinkProps) {
  return <Link className={buttonClass({ variant, size, className })} {...rest} />;
}
