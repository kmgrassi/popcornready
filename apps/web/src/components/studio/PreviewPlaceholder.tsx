import styles from "./PreviewPlaceholder.module.css";

interface PreviewPlaceholderProps {
  /**
   * When true, render the in-progress variant (a run is generating a cut)
   * instead of the idle "nothing yet" variant.
   */
  loading?: boolean;
}

/**
 * Pre-generation preview state. Replaces the old black rectangle with an
 * intentional, on-brand placeholder that tells the user what will appear here.
 * Consumes design tokens only — no hard-coded colors or sizes.
 */
export function PreviewPlaceholder({ loading = false }: PreviewPlaceholderProps) {
  return (
    <div
      className={styles.frame}
      role="status"
      aria-live="polite"
      data-loading={loading || undefined}
    >
      <div className={styles.inner}>
        <div className={styles.iconWrap} aria-hidden="true">
          {loading ? (
            <span className={styles.spinner} />
          ) : (
            <VideoCardIcon className={styles.icon} />
          )}
        </div>
        {loading ? (
          <>
            <p className={styles.primary}>Generating your rough cut…</p>
            <p className={styles.secondary}>
              Assembling timing, pacing, and edits. This usually takes a moment.
            </p>
          </>
        ) : (
          <>
            <p className={styles.primary}>Your rough cut will appear here</p>
            <p className={styles.secondary}>
              Generate a video to preview timing, pacing, and edits.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function VideoCardIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="40"
      height="40"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
      <path d="M10 9.2v5.6l4.6-2.8z" fill="currentColor" stroke="none" />
    </svg>
  );
}
