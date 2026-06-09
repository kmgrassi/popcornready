import { useState } from "react";
import type { Clip, Project, Timeline } from "@popcorn/shared/types";
import { DEFAULT_DURATION_POLICY } from "@popcorn/shared/audio-alignment";
import { Button } from "../ui/Button";
import { PreviewPanel } from "../editor/PreviewPanel";
import { PreviewPlayer } from "../PreviewPlayer";
import { TimelinePanel } from "./TimelinePanel";
import styles from "./ReviewStep.module.css";

interface ReviewStepProps {
  project: Project | null | undefined;
  timeline: Timeline | null | undefined;
  timelineId?: string;
  clips: Clip[];
  loading: boolean;
  error?: string;
  onFeedback(note: string): Promise<void>;
  onExport(): void;
}

export function ReviewStep({
  project,
  timeline,
  timelineId,
  clips,
  loading,
  error,
  onFeedback,
  onExport,
}: ReviewStepProps) {
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const hasTimeline = !!timeline && timeline.segments.length > 0;

  async function sendFeedback() {
    if (!note.trim() || pending) return;
    setPending(true);
    setFeedbackError(null);
    setSent(false);
    try {
      await onFeedback(note);
      setSent(true);
    } catch (sendError) {
      setFeedbackError(
        sendError instanceof Error ? sendError.message : "Could not send feedback.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <section className={styles.review} aria-labelledby="studio-review-heading">
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Review & edit</p>
          <h2 id="studio-review-heading" className={styles.heading}>
            Your rough cut is ready
          </h2>
        </div>
        <Button variant="cta" onClick={onExport} disabled={!hasTimeline}>
          Continue to export
        </Button>
      </header>

      {loading ? <p className="muted">Loading the generated timeline...</p> : null}
      {error ? <p className="new-project-error">{error}</p> : null}

      <div className={styles.layout}>
        <div className={styles.previewColumn}>
          <PreviewPanel
            Preview={PreviewPlayer}
            audioClips={clips.filter((clip) => clip.kind === "audio")}
            busy={loading}
            createdVideos={[]}
            durationPolicy={DEFAULT_DURATION_POLICY}
            exportResult={null}
            galleryLoading={false}
            loadedVideoThumbs={{}}
            plan={project?.plan ?? undefined}
            selectedAudioClipId=""
            setDurationPolicy={() => {}}
            setLoadedVideoThumbs={() => {}}
            setSelectedAudioClipId={() => {}}
            timeline={timeline ?? null}
            clips={clips}
            onAlignAudio={() => {}}
            onExport={onExport}
            onRefreshCreatedVideos={() => {}}
            showActions={false}
          />

          {hasTimeline ? (
            <div className={styles.feedback}>
              <label className={styles.feedbackLabel} htmlFor="studio-review-feedback">
                Feedback for regeneration
              </label>
              <textarea
                id="studio-review-feedback"
                value={note}
                onChange={(event) => {
                  setNote(event.target.value);
                  setSent(false);
                }}
                placeholder="Tell the generator what to change in this rough cut."
                rows={4}
              />
              <div className={styles.feedbackActions}>
                <Button
                  variant="secondary"
                  onClick={sendFeedback}
                  disabled={!note.trim() || pending || !timelineId}
                >
                  {pending ? "Sending..." : "Regenerate with feedback"}
                </Button>
                {!timelineId ? (
                  <span className={styles.hint}>
                    Feedback will activate once the run exposes a timeline id.
                  </span>
                ) : null}
                {sent ? <span className={styles.hint}>Feedback sent.</span> : null}
              </div>
              {feedbackError ? (
                <p className="new-project-error" role="alert">
                  {feedbackError}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        {hasTimeline ? <TimelinePanel timeline={timeline} clips={clips} /> : null}
      </div>
    </section>
  );
}
