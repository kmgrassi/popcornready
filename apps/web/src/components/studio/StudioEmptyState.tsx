import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import type { StudioDraftSummary } from "../../lib/draftStore";
import styles from "./StudioShell.module.css";

export interface StudioEmptyStateProps {
  drafts?: StudioDraftSummary[];
  loading?: boolean;
  error?: string | null;
  onResume?: (draftId: string) => void;
  onDelete?: (draftId: string) => void;
}

/**
 * StudioEmptyState — the Studio zero state (PR 1). The first thing a new user
 * sees: one headline, one line of support, and any resumable drafts. Starting
 * a new video lives in the app navigation.
 */
export function StudioEmptyState({
  drafts = [],
  loading = false,
  error = null,
  onResume,
  onDelete,
}: StudioEmptyStateProps) {
  return (
    <div className={styles.startScreen}>
      <EmptyState
        headline="Create your first AI rough cut"
        supporting="Start with a brief, add footage, then review an editable timeline."
      />
      <section className={styles.draftPanel} aria-label="Continue a draft">
        <div className={styles.draftHeader}>
          <h2>Continue a draft</h2>
          {loading ? <span className="muted">Loading...</span> : null}
        </div>
        {error ? <p className={styles.draftError}>{error}</p> : null}
        {!loading && drafts.length === 0 ? (
          <p className="muted">Saved drafts will appear here.</p>
        ) : null}
        {drafts.length > 0 ? (
          <ul className={styles.draftList}>
            {drafts.map((draft) => (
              <li className={styles.draftRow} key={draft.draftId}>
                <button
                  className={styles.draftOpen}
                  type="button"
                  onClick={() => onResume?.(draft.draftId)}
                >
                  <span className={styles.draftTitle}>{draft.excerpt}</span>
                  <span className={styles.draftMeta}>
                    {stepLabel(draft.step)} - updated {formatUpdatedAt(draft.updatedAt)}
                  </span>
                </button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onDelete?.(draft.draftId)}
                >
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}

function stepLabel(step: StudioDraftSummary["step"]): string {
  const labels: Record<StudioDraftSummary["step"], string> = {
    brief: "Brief",
    footage: "Footage",
    story: "Story",
    generate: "Checkpoints",
    review: "Review",
    export: "Export",
  };
  return labels[step];
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "recently";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
