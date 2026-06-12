import type { ButtonHTMLAttributes, MouseEvent, ReactNode } from "react";
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
  fullWidth?: boolean;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  isLoading?: boolean;
}

function buttonClass({ variant = "primary", size = "md", fullWidth, className }: ButtonStyleProps) {
  return [styles.btn, styles[variant], styles[size], fullWidth ? styles.fullWidth : null, className]
    .filter(Boolean)
    .join(" ");
}

export function Button({
  variant,
  size,
  fullWidth,
  leadingIcon,
  trailingIcon,
  isLoading = false,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonStyleProps & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={buttonClass({ variant, size, fullWidth, className })}
      disabled={disabled || isLoading}
      aria-busy={isLoading || undefined}
      {...rest}
    >
      {isLoading ? <span className={styles.spinner} aria-hidden="true" /> : leadingIcon}
      <span className={styles.label}>{children}</span>
      {trailingIcon}
    </button>
  );
}

export function ButtonLink({
  variant,
  size,
  fullWidth,
  leadingIcon,
  trailingIcon,
  isLoading = false,
  className,
  children,
  onClick,
  tabIndex,
  "aria-disabled": ariaDisabled,
  ...rest
}: ButtonStyleProps & LinkProps) {
  const disabled = isLoading || ariaDisabled === true || ariaDisabled === "true";

  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    if (disabled) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    onClick?.(event);
  }

  return (
    <Link
      className={buttonClass({ variant, size, fullWidth, className })}
      aria-busy={isLoading || undefined}
      aria-disabled={disabled || undefined}
      onClick={handleClick}
      tabIndex={disabled ? -1 : tabIndex}
      {...rest}
    >
      {isLoading ? <span className={styles.spinner} aria-hidden="true" /> : leadingIcon}
      <span className={styles.label}>{children}</span>
      {trailingIcon}
    </Link>
  );
}
