import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { GenerationRun } from "@popcorn/shared/v1/types";
import { ProgressView } from "../components/progress/ProgressView";
import { v1Api } from "../lib/api-client";
import type { GenerationRunDetail } from "../lib/v1/generation-runs/status";
import {
  clearLastRunHint,
  readLastRunHint,
  writeLastRunHint,
} from "../lib/v1/generation-runs/recovery";

const POLL_INTERVAL_MS = 2000;
const REVIEW_POLL_INTERVAL_MS = 15000;

function isTerminal(status: GenerationRun["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

export function RunProgressPage() {
  const { projectId, runId } = useParams();

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

  return <RunProgress projectId={projectId} runId={runId} />;
}

function RunProgress({ projectId, runId }: { projectId: string; runId: string }) {
  const [payload, setPayload] = useState<GenerationRunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState<
    "approve" | "reject" | "cancel" | undefined
  >();
  const [actionError, setActionError] = useState<string | null>(null);
  const pollNowRef = useRef<(() => void) | null>(null);
  const hint = readLastRunHint(projectId);

  const applyPayload = useCallback(
    (next: GenerationRunDetail) => {
      setPayload(next);
      setError(null);
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
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();

    async function poll() {
      try {
        const data = await v1Api.getGenerationRun(projectId, runId, controller.signal);
        if (cancelled) return;
        applyPayload(data);

        if (isTerminal(data.run.status)) return;
        if (document.visibilityState === "hidden") return;
        timer = setTimeout(
          poll,
          data.run.reviewGate ? REVIEW_POLL_INTERVAL_MS : POLL_INTERVAL_MS,
        );
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
        timer = setTimeout(poll, POLL_INTERVAL_MS * 2);
      }
    }

    void poll();
    pollNowRef.current = () => {
      if (timer) clearTimeout(timer);
      void poll();
    };

    function onVisibilityChange() {
      if (document.visibilityState !== "visible") return;
      if (timer) clearTimeout(timer);
      void poll();
    }

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
      pollNowRef.current = null;
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [applyPayload, projectId, runId]);

  async function runAction(action: "approve" | "reject" | "cancel") {
    if (actionPending) return;
    setActionPending(action);
    setActionError(null);
    try {
      const body =
        action === "reject" && payload?.run.reviewGate
          ? {
              stageType: payload.run.reviewGate.stageType,
              note: "Regenerate from review feedback.",
            }
          : undefined;
      const data = await v1Api.updateGenerationRun(projectId, runId, action, body);
      applyPayload(data);
      if (action === "cancel") {
        clearLastRunHint(projectId);
      }
      pollNowRef.current?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionPending(undefined);
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
          <Link className="secondary compact" to="/studio">
            Back to studio
          </Link>
        </div>
      </main>
    );
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
              onApprove: () => void runAction("approve"),
              onReject: () => void runAction("reject"),
              onCancel: () => void runAction("cancel"),
            }
          : undefined
      }
    />
  );
}
