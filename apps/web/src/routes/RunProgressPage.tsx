import { useCallback, useEffect, useState } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import type { GenerationRun } from "@popcorn/shared/v1/types";
import { ProgressView } from "../components/progress/ProgressView";
import type { GenerationRunDetail } from "../lib/v1/generation-runs/status";
import {
  clearLastRunHint,
  readLastRunHint,
  writeLastRunHint,
} from "../lib/v1/generation-runs/recovery";
import {
  useGenerationRunQuery,
  useUpdateGenerationRunMutation,
} from "../lib/queryClient";

function isTerminal(status: GenerationRun["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

function studioReviewPath(draftId: string): string {
  const params = new URLSearchParams({
    draft: draftId,
    step: "review",
  });
  return `/studio?${params.toString()}`;
}

export function RunProgressPage() {
  const { projectId, runId } = useParams();
  const [params] = useSearchParams();
  const studioDraftId = params.get("studioDraft");

  if (!projectId || !runId) {
    return (
      <main className="progress-shell">
        <div className="progress-empty-card">
          <h1 className="progress-title">Run not found</h1>
          <p className="muted">This progress URL is missing a project or run id.</p>
        </div>
      </main>
    );
  }

  return (
    <RunProgress
      projectId={projectId}
      runId={runId}
      studioDraftId={studioDraftId}
    />
  );
}

function RunProgress({
  projectId,
  runId,
  studioDraftId,
}: {
  projectId: string;
  runId: string;
  studioDraftId?: string | null;
}) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [reviewFeedbackNote, setReviewFeedbackNote] = useState("");
  const hint = readLastRunHint(projectId);
  const studioReturnPath = studioDraftId ? studioReviewPath(studioDraftId) : null;
  const runQuery = useGenerationRunQuery(projectId, runId);
  const updateRun = useUpdateGenerationRunMutation(projectId, runId);
  const payload = runQuery.data ?? null;
  const error =
    runQuery.error instanceof Error
      ? runQuery.error.message
      : runQuery.error
        ? String(runQuery.error)
        : null;
  const actionPending = updateRun.isPending
    ? updateRun.variables?.action
    : undefined;
  const reviewGateKey = payload?.run.reviewGate?.stageId ?? null;

  const applyPayload = useCallback(
    (next: GenerationRunDetail) => {
      if (isTerminal(next.run.status)) {
        if (next.run.runId === runId) {
          writeLastRunHint(projectId, next.run);
        }
      } else {
        writeLastRunHint(projectId, next.run);
      }
    },
    [projectId, runId],
  );

  useEffect(() => {
    if (payload) applyPayload(payload);
  }, [applyPayload, payload]);

  useEffect(() => {
    setReviewFeedbackNote("");
  }, [reviewGateKey]);

  async function runAction(action: "approve" | "reject" | "cancel", note?: string) {
    if (actionPending) return;
    setActionError(null);
    try {
      const trimmedNote = note?.trim();
      const body =
        action === "reject" && payload?.run.reviewGate
          ? {
              stageType: payload.run.reviewGate.stageType,
              ...(trimmedNote ? { note: trimmedNote } : {}),
            }
          : action === "approve" && trimmedNote
            ? { note: trimmedNote }
            : undefined;
      const data = await updateRun.mutateAsync({ action, body });
      applyPayload(data);
      if (action === "approve" || action === "reject") {
        setReviewFeedbackNote("");
      }
      if (action === "cancel") {
        clearLastRunHint(projectId);
      }
      void runQuery.refetch();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  if (!payload) {
    return (
      <main className="progress-shell">
        <div className="progress-empty-card">
          <h1 className="progress-title">Starting generation</h1>
          <p className={`muted${error ? " lp-prompt-error" : ""}`}>
            {error ?? "Preparing your progress view."}
          </p>
          {hint ? (
            <p className="muted">
              Last seen run <code>{hint.runId}</code> was {hint.status}.
            </p>
          ) : null}
          <Link className="secondary compact" to={studioReturnPath ?? "/studio"}>
            Back to studio
          </Link>
        </div>
      </main>
    );
  }

  if (studioReturnPath && payload.run.status === "succeeded") {
    return <Navigate to={studioReturnPath} replace />;
  }

  return (
    <ProgressView
      run={payload.run}
      stages={payload.stages}
      stageItems={payload.stageItems}
      cancelAction={
        !payload.run.reviewGate && !isTerminal(payload.run.status)
          ? {
              pending: actionPending === "cancel",
              error: actionError,
              onCancel: () => void runAction("cancel"),
            }
          : undefined
      }
      reviewActions={
        payload.run.reviewGate
          ? {
              pending: actionPending,
              error: actionError,
              feedbackNote: reviewFeedbackNote,
              onFeedbackNoteChange: setReviewFeedbackNote,
              onApprove: (note) => void runAction("approve", note),
              onReject: (note) => void runAction("reject", note),
              onCancel: () => void runAction("cancel"),
            }
          : undefined
      }
    />
  );
}
