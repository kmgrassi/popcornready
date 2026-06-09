import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";

export interface StudioEmptyStateProps {
  /** Enter the Brief step and start a new video. */
  onStart: () => void;
}

/**
 * StudioEmptyState — the Studio zero state (PR 1). The first thing a new user
 * sees: one headline, one line of support, and a single prominent CTA so the
 * first action is obvious within seconds.
 */
export function StudioEmptyState({ onStart }: StudioEmptyStateProps) {
  return (
    <EmptyState
      headline="Create your first AI rough cut"
      supporting="Start with a brief, add footage, then review an editable timeline."
      action={
        <Button variant="cta" size="lg" onClick={onStart}>
          Start new video
        </Button>
      }
    />
  );
}
