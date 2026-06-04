"use client";

import { Link } from "react-router-dom";
import { useEffect, useState } from "react";
import {
  GENERATION_STAGE_LABELS,
  type GenerationRun,
  type GenerationStage,
  type GenerationStageItem,
} from "@popcorn/shared/v1/types";
import { StageItemCard } from "../generation-progress/StageItemCard";
import { JudgmentBadge } from "../evals/JudgmentBadge";
import {
  GenerationRunClient,
  GenerationRunRequestError,
} from "../../lib/v1/generation-runs/client";
import { StageRail } from "./StageRail";
import { StatusBanner } from "./StatusBanner";
import { TerminalState } from "./TerminalState";

interface ProgressViewProps {
  run: GenerationRun;
  stages: GenerationStage[];
  stageItems?: GenerationStageItem[];
  reviewActions?: {
    pending?: "approve" | "reject" | "cancel";
    error?: string | null;
    onApprove: () => void;
    onReject: () => void;
    onCancel: () => void;
  };
  cancelAction?: {
    pending?: boolean;
    error?: string | null;
    onCancel: () => void;
  };
  /** Optional list of other demo runs to link to from the header. */
  alternateRuns?: { runId: string; label: string }[];
}

function isTerminal(status: GenerationRun["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

export function ProgressView({
  run,
  stages,
  stageItems = [],
  reviewActions,
  cancelAction,
  alternateRuns,
}: ProgressViewProps) {
  const [detail, setDetail] = useState({ run, stages, stageItems });
  const [fallbackApproving, setFallbackApproving] = useState(false);
  const [fallbackError, setFallbackError] = useState<string | null>(null);

  useEffect(() => {
    setDetail({ run, stages, stageItems });
    setFallbackApproving(false);
    setFallbackError(null);
  }, [run, stages, stageItems]);

  const terminal = isTerminal(detail.run.status);
  const reviewStage = detail.run.reviewGate
    ? detail.stages.find((stage) => stage.stageId === detail.run.reviewGate?.stageId)
    : undefined;
  const reviewItems = detail.run.reviewGate
    ? detail.stageItems.filter((item) => item.stageId === detail.run.reviewGate?.stageId)
    : [];
  const generatedItems = detail.run.reviewGate
    ? detail.stageItems.filter((item) => item.stageId !== detail.run.reviewGate?.stageId)
    : detail.stageItems;
  const pending = reviewActions?.pending ?? (fallbackApproving ? "approve" : undefined);
  const actionError = reviewActions?.error ?? fallbackError;
  const showCancelAction = !terminal && !detail.run.reviewGate && !!cancelAction;

  async function approveFallback() {
    const reviewGate = detail.run.reviewGate;
    if (!reviewGate || fallbackApproving) return;
    setFallbackApproving(true);
    setFallbackError(null);

    if (detail.run.runId.startsWith("demo-")) {
      const now = new Date().toISOString();
      const ordered = [...detail.stages].sort((a, b) => a.order - b.order);
      const gateIndex = ordered.findIndex((stage) => stage.stageId === reviewGate.stageId);
      const next = ordered.slice(gateIndex + 1).find((stage) => stage.status === "queued");
      setDetail((current) => ({
        ...current,
        run: {
          ...current.run,
          reviewGate: null,
          currentStageType: next?.type ?? current.run.currentStageType,
          message: next
            ? `${GENERATION_STAGE_LABELS[next.type]} is in progress.`
            : "Review approved. Continuing the run.",
          updatedAt: now,
        },
        stages: current.stages.map((stage) => {
          if (stage.stageId === reviewGate.stageId) return { ...stage, reviewedAt: now };
          if (next && stage.stageId === next.stageId) {
            return {
              ...stage,
              status: "running",
              startedAt: now,
              message: `${GENERATION_STAGE_LABELS[next.type]} started.`,
            };
          }
          return stage;
        }),
      }));
      setFallbackApproving(false);
      return;
    }

    try {
      const client = new GenerationRunClient();
      const nextDetail = await client.approveRun(detail.run.projectId, detail.run.runId);
      setDetail({
        run: nextDetail.run,
        stages: nextDetail.stages,
        stageItems: nextDetail.stageItems,
      });
    } catch (err) {
      setFallbackError(
        err instanceof GenerationRunRequestError
          ? err.message
          : "Could not approve this review gate.",
      );
    } finally {
      setFallbackApproving(false);
    }
  }

  const onApprove = reviewActions?.onApprove ?? approveFallback;

  return (
    <div className="progress-shell">
      <header className="progress-header">
        <div>
          <p className="progress-eyebrow">Generation run</p>
          <h1 className="progress-title">
            {detail.run.projectId === "demo-project" ? "Demo project" : detail.run.projectId}
          </h1>
          <p className="progress-subtitle muted">
            Run <code>{detail.run.runId}</code>
          </p>
        </div>
        {alternateRuns && alternateRuns.length > 0 ? (
          <nav className="progress-alt-runs" aria-label="Other demo states">
            <span className="progress-alt-runs-label">View other states:</span>
            <ul>
              {alternateRuns.map((alt) => (
                <li key={alt.runId}>
                  <Link
                    to={`/projects/${detail.run.projectId}/runs/${alt.runId}`}
                    className={`progress-alt-link${
                      alt.runId === detail.run.runId ? " active" : ""
                    }`}
                  >
                    {alt.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
      </header>

      <div className="progress-body">
        <section className="progress-main">
          {terminal ? <TerminalState run={detail.run} /> : <StatusBanner run={detail.run} />}

          {showCancelAction ? (
            <section
              className="progress-empty-card awaiting-review-card"
              aria-labelledby="run-actions-heading"
            >
              <div className="review-gate-head">
                <div>
                  <p className="progress-eyebrow">Run controls</p>
                  <h2 id="run-actions-heading" className="progress-card-heading">
                    Active generation
                  </h2>
                </div>
                <div className="review-actions">
                  <button
                    type="button"
                    className="secondary compact"
                    onClick={cancelAction.onCancel}
                    disabled={cancelAction.pending}
                  >
                    {cancelAction.pending ? "Canceling..." : "Cancel generation"}
                  </button>
                </div>
              </div>
              {cancelAction.error ? (
                <p className="review-gate-error" role="alert">
                  {cancelAction.error}
                </p>
              ) : null}
            </section>
          ) : null}

          {detail.run.reviewGate ? (
            <section
              className="review-gate-card awaiting-review-card"
              aria-labelledby="review-gate-heading"
            >
              <div className="review-gate-head">
                <div>
                  <p className="progress-eyebrow">Awaiting review</p>
                  <h2 id="review-gate-heading" className="progress-card-heading">
                    {reviewStage?.label ??
                      GENERATION_STAGE_LABELS[detail.run.reviewGate.stageType]}{" "}
                    is ready
                  </h2>
                </div>
                <JudgmentBadge judgment={reviewStage?.judgment ?? null} />
                <div className="review-actions">
                  <button
                    type="button"
                    className="primary compact"
                    onClick={onApprove}
                    disabled={!!pending}
                  >
                    {pending === "approve" ? "Approving..." : "Approve & continue"}
                  </button>
                  {reviewActions ? (
                    <>
                      <button
                        type="button"
                        className="secondary compact"
                        onClick={reviewActions.onReject}
                        disabled={!!pending}
                      >
                        {pending === "reject"
                          ? "Regenerating..."
                          : "Reject / regenerate"}
                      </button>
                      <button
                        type="button"
                        className="secondary compact"
                        onClick={reviewActions.onCancel}
                        disabled={!!pending}
                      >
                        {pending === "cancel" ? "Canceling..." : "Cancel generation"}
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
              <p className="review-gate-copy">
                {reviewStage?.message ??
                  "Inspect this stage's output before the next generation stage starts."}
              </p>
              {actionError ? (
                <p className="review-gate-error" role="alert">
                  {actionError}
                </p>
              ) : null}
              {reviewItems.length > 0 ? (
                <div className="stage-item-grid review-output-grid">
                  {reviewItems.map((item) => (
                    <StageItemCard key={item.itemId} item={item} />
                  ))}
                </div>
              ) : (
                <div className="review-output-empty">
                  <span className="muted">
                    This stage has no itemized output yet. Review the stage summary above.
                  </span>
                </div>
              )}
            </section>
          ) : null}

          <section
            className="progress-empty-card awaiting-review-card"
            aria-labelledby="generated-assets-heading"
          >
            <h2 id="generated-assets-heading" className="progress-card-heading">
              Generated assets
            </h2>
            {generatedItems.length > 0 ? (
              <div className="stage-item-grid review-output-grid">
                {generatedItems.map((item) => (
                  <StageItemCard key={item.itemId} item={item} />
                ))}
              </div>
            ) : (
              <p className="muted">
                Generated visuals, audio, and timeline beats will appear here as
                each stage produces them.
              </p>
            )}
          </section>
        </section>

        <aside className="progress-rail-pane" aria-label="Stage rail">
          <h2 className="progress-rail-heading">Stages</h2>
          <StageRail stages={detail.stages} reviewGate={detail.run.reviewGate} />
        </aside>
      </div>
    </div>
  );
}
