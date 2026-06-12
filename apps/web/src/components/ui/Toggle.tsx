import { useId, type InputHTMLAttributes, type ReactNode } from "react";
import styles from "./Toggle.module.css";

export interface ToggleProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: ReactNode;
  description?: ReactNode;
}

export function Toggle({ label, description, className, id, disabled, ...rest }: ToggleProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const descriptionId = description ? `${inputId}-description` : undefined;

  return (
    <label className={[styles.root, disabled ? styles.disabled : null, className].filter(Boolean).join(" ")}>
      <span className={styles.copy}>
        <span className={styles.label}>{label}</span>
        {description ? (
          <span className={styles.description} id={descriptionId}>
            {description}
          </span>
        ) : null}
      </span>
      <input
        id={inputId}
        className={styles.input}
        type="checkbox"
        role="switch"
        disabled={disabled}
        aria-describedby={descriptionId}
        {...rest}
      />
      <span className={styles.track} aria-hidden="true">
        <span className={styles.thumb} />
      </span>
    </label>
  );
}
