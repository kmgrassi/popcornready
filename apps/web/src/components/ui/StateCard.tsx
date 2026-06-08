import type { ReactNode } from "react";
import { ApiClientError } from "../../lib/api-client";
import { Button } from "./Button";
import styles from "./StateCard.module.css";

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className={styles.card}>
      <h2 className={styles.title}>{title}</h2>
      <p className={styles.body}>{body}</p>
      {action ? <div className={styles.actions}>{action}</div> : null}
    </div>
  );
}

function AlertIcon() {
  return (
    <svg
      className={styles.icon}
      viewBox="0 0 24 24"
      width="20"
      height="20"
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 3 1.5 21h21L12 3Zm0 6v5m0 3.5h.01"
      />
    </svg>
  );
}

export function ErrorState({
  title,
  body,
  error,
  onRetry,
}: {
  title: string;
  body: string;
  error: Error;
  onRetry: () => void;
}) {
  const apiError = error instanceof ApiClientError ? error : null;
  const details: { label: string; value: string }[] = [];
  if (apiError) {
    details.push({ label: "Code", value: apiError.code });
    details.push({ label: "Status", value: String(apiError.status) });
    if (apiError.requestId) {
      details.push({ label: "Request", value: apiError.requestId });
    }
  }

  return (
    <div className={styles.errorCard} role="alert">
      <div className={styles.errorHeader}>
        <span className={styles.iconWrap}>
          <AlertIcon />
        </span>
        <div className={styles.text}>
          <h2 className={styles.title}>{title}</h2>
          <p className={styles.body}>{body}</p>
        </div>
      </div>

      {details.length > 0 || error.message ? (
        <dl className={styles.details}>
          {details.map((detail) => (
            <div className={styles.detailRow} key={detail.label}>
              <dt>{detail.label}</dt>
              <dd>{detail.value}</dd>
            </div>
          ))}
          {!apiError && error.message ? (
            <div className={styles.detailRow}>
              <dt>Detail</dt>
              <dd>{error.message}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      <div className={styles.actions}>
        <Button variant="secondary" onClick={onRetry}>
          Retry
        </Button>
      </div>
    </div>
  );
}
