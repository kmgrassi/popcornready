"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  GENERATION_STAGE_LABELS,
  GenerationRun,
  GenerationStage,
  GenerationStageItem,
} from "@/lib/v1/types";
import { StageItemCard } from "@/components/generation-progress/StageItemCard";
import {
  GenerationRunClient,
  GenerationRunRequestError,
} from "@/lib/v1/generation-runs/client";
import { StageRail } from "./StageRail";
import { StatusBanner } from "./StatusBanner";
import { TerminalState } from "./TerminalState";

interface ProgressViewProps {
  run: GenerationRun;
  stages: GenerationStage[];
  stageItems?: GenerationStageItem[];
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
  alternateRuns,
}: ProgressViewProps) {
  const [detail, setDetail] = useState({ run, stages, stageItems });
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const terminal = isTerminal(detail.run.status);
  const reviewGate = detail.run.reviewGate ?? null;
  const reviewStage = reviewGate
    ? detail.stages.find((stage) => stage.stageId === reviewGate.stageId)
    : undefined;
  const reviewItems = useMemo(
    () =>
      reviewGate
        ? detail.stageItems.filter((item) => item.stageId === reviewGate.stageId)
        : [],
    [detail.stageItems, reviewGate],
  );

  async function approveReview() {
    if (!reviewGate || approving) return;
    setApproving(true);
    setApproveError(null);

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
      setApproving(false);
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
      setApproveError(
        err instanceof GenerationRunRequestError
          ? err.message
          : "Could not approve this review gate.",
      );
    } finally {
      setApproving(false);
    }
  }

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
                    href={`/projects/${detail.run.projectId}/runs/${alt.runId}`}
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

          {reviewGate && reviewStage ? (
            <section className="review-gate-card" aria-labelledby="review-gate-heading">
              <div className="review-gate-head">
                <div>
                  <p className="progress-eyebrow">Awaiting review</p>
                  <h2 id="review-gate-heading" className="progress-card-heading">
                    {GENERATION_STAGE_LABELS[reviewGate.stageType]} is ready
                  </h2>
                </div>
                <button
                  type="button"
                  className="primary review-approve-button"
                  onClick={approveReview}
                  disabled={approving}
                >
                  {approving ? "Approving..." : "Approve & continue"}
                </button>
              </div>
              <p className="review-gate-copy">
                {reviewStage.message ??
                  "Inspect this stage's output before the next generation stage starts."}
              </p>
              {approveError ? (
                <p className="review-gate-error" role="alert">
                  {approveError}
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
          ) : (
            <div className="progress-empty-card">
              <h2 className="progress-card-heading">Generated assets</h2>
              <p className="muted">
                Generated visuals, audio, and timeline beats will appear here as
                each stage produces them.
              </p>
            </div>
          )}
        </section>

        <aside className="progress-rail-pane" aria-label="Stage rail">
          <h2 className="progress-rail-heading">Stages</h2>
          <StageRail stages={detail.stages} reviewStageId={reviewGate?.stageId} />
        </aside>
      </div>
    </div>
  );
}
