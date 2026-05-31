"use client";

import {
  GENERATION_STAGE_LABELS,
  GenerationRun,
} from "@/lib/v1/types";
import { formatElapsed, useElapsedTime } from "./useElapsedTime";

interface StatusBannerProps {
  run: GenerationRun;
}

export function StatusBanner({ run }: StatusBannerProps) {
  const elapsed = useElapsedTime(run.startedAt, undefined);
  const stageLabel = run.currentStageType
    ? GENERATION_STAGE_LABELS[run.currentStageType]
    : null;
  const reviewStageLabel = run.reviewGate
    ? GENERATION_STAGE_LABELS[run.reviewGate.stageType]
    : null;

  const heading =
    reviewStageLabel
      ? `${reviewStageLabel} — ready for review`
      : run.status === "queued"
      ? "Waiting to start"
      : stageLabel
        ? `${stageLabel} — in progress`
        : "Generating your video";

  return (
    <div className="status-banner">
      <div className="status-banner-head">
        <span
          className={`status-banner-dot status-banner-dot-${
            run.reviewGate ? "review" : run.status
          }`}
        />
        <span className="status-banner-heading">{heading}</span>
      </div>
      <p className="status-banner-message" role="status" aria-live="polite" aria-atomic="true">
        {run.reviewGate
          ? "Review this stage's output, then approve to continue the run."
          : run.message ?? "Tracking progress…"}
      </p>
      <div className="status-banner-meta" aria-live="off">
        <span className="status-banner-meta-label">Elapsed</span>
        <span className="status-banner-meta-value">
          {elapsed === null ? "—" : formatElapsed(elapsed)}
        </span>
        {run.progressPercent != null ? (
          <>
            <span className="status-banner-meta-sep" aria-hidden>·</span>
            <span className="status-banner-meta-label">Overall</span>
            <span className="status-banner-meta-value">
              {Math.round(run.progressPercent)}%
            </span>
          </>
        ) : null}
      </div>
    </div>
  );
}
