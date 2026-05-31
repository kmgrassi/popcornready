"use client";

import {
  GENERATION_STAGE_LABELS,
  GenerationRunStatus,
  GenerationStage,
} from "@/lib/v1/types";

interface StageRailProps {
  stages: GenerationStage[];
  reviewStageId?: string;
}

const STATUS_LABEL: Record<GenerationRunStatus, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Done",
  failed: "Failed",
  canceled: "Canceled",
};

function StatusGlyph({ status }: { status: GenerationRunStatus }) {
  if (status === "succeeded") return <span className="stage-glyph" aria-hidden>✓</span>;
  if (status === "failed") return <span className="stage-glyph" aria-hidden>✕</span>;
  if (status === "canceled") return <span className="stage-glyph" aria-hidden>—</span>;
  if (status === "running") {
    return (
      <span className="stage-glyph" aria-hidden>
        <span className="stage-pulse" />
      </span>
    );
  }
  return (
    <span className="stage-glyph" aria-hidden>
      <span className="stage-dot" />
    </span>
  );
}

export function StageRail({ stages, reviewStageId }: StageRailProps) {
  const ordered = [...stages].sort((a, b) => a.order - b.order);

  return (
    <ol className="stage-rail" aria-label="Generation stages">
      {ordered.map((stage, idx) => {
        const isLast = idx === ordered.length - 1;
        const label = stage.label || GENERATION_STAGE_LABELS[stage.type];
        const message = stage.error?.message ?? stage.message;

        return (
          <li
            key={stage.stageId}
            className={`stage-row stage-${stage.status}${
              stage.stageId === reviewStageId ? " awaiting-review" : ""
            }`}
            aria-current={
              stage.stageId === reviewStageId || stage.status === "running"
                ? "step"
                : undefined
            }
          >
            <div className="stage-marker">
              <StatusGlyph status={stage.status} />
              {!isLast && <span className="stage-connector" aria-hidden />}
            </div>
            <div className="stage-body">
              <div className="stage-title-row">
                <span className="stage-title">{label}</span>
                <span className={`stage-status-pill stage-status-${stage.status}`}>
                  {stage.stageId === reviewStageId
                    ? "Review"
                    : stage.reviewedAt
                      ? "Reviewed"
                      : STATUS_LABEL[stage.status]}
                </span>
              </div>
              {stage.stageId === reviewStageId ? (
                <p className="stage-message">Ready for your review.</p>
              ) : message ? (
                <p className="stage-message">{message}</p>
              ) : (
                <p className="stage-message muted">
                  {stage.status === "queued" ? "Waiting in line." : null}
                </p>
              )}
              {stage.status === "running" && stage.progressPercent != null ? (
                <div
                  className="stage-progress"
                  role="progressbar"
                  aria-valuenow={stage.progressPercent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div
                    className="stage-progress-fill"
                    style={{ width: `${Math.max(2, Math.min(100, stage.progressPercent))}%` }}
                  />
                </div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
