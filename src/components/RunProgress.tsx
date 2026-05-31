"use client";

import React, { useEffect, useRef, useState } from "react";

import { ProgressView } from "@/components/progress/ProgressView";
import {
  GenerationRun,
  GenerationStage,
  GenerationStageItem,
} from "@/lib/v1/types";

const POLL_INTERVAL_MS = 2000;
const REVIEW_POLL_INTERVAL_MS = 15000;

interface GenerationRunPayload {
  run: GenerationRun;
  stages: GenerationStage[];
  stageItems?: GenerationStageItem[];
}

function isTerminal(status: GenerationRun["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

export function RunProgress({
  projectId,
  runId,
  onReady,
}: {
  projectId: string;
  runId: string;
  onReady: () => void;
}) {
  const [payload, setPayload] = useState<GenerationRunPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState<"approve" | "reject" | "cancel" | undefined>();
  const [actionError, setActionError] = useState<string | null>(null);
  const readyFired = useRef(false);
  const pollNowRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      try {
        const res = await fetch(
          `/api/v1/projects/${encodeURIComponent(projectId)}/generation-runs/${encodeURIComponent(runId)}`,
          { cache: "no-store" }
        );
        if (cancelled) return;
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data?.error?.message || `Run lookup failed (${res.status})`);
        }

        const data = (await res.json()) as GenerationRunPayload;
        setPayload(data);
        setError(null);

        if (data.run.status === "succeeded" && !readyFired.current) {
          readyFired.current = true;
          onReady();
          return;
        }
        if (isTerminal(data.run.status)) return;
        if (document.visibilityState === "hidden") return;
        timer = setTimeout(
          poll,
          data.run.reviewGate ? REVIEW_POLL_INTERVAL_MS : POLL_INTERVAL_MS
        );
      } catch (err) {
        if (cancelled) return;
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
      if (timer) clearTimeout(timer);
      pollNowRef.current = null;
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [projectId, runId, onReady]);

  async function runAction(action: "approve" | "reject" | "cancel") {
    setActionPending(action);
    setActionError(null);
    try {
      const suffix =
        action === "approve" ? "approve" : action === "reject" ? "reject" : "cancel";
      const body =
        action === "reject" && payload?.run.reviewGate
          ? {
              stageType: payload.run.reviewGate.stageType,
              note: "Regenerate from review feedback.",
            }
          : {};
      const res = await fetch(
        `/api/v1/projects/${encodeURIComponent(projectId)}/generation-runs/${encodeURIComponent(runId)}/${suffix}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          cache: "no-store",
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error?.message || `${suffix} failed (${res.status})`);
      }
      setPayload(data as GenerationRunPayload);
      pollNowRef.current?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionPending(undefined);
    }
  }

  if (!payload) {
    return (
      <div className="progress-shell">
        <div className="progress-empty-card">
          <h1 className="progress-title">Starting generation</h1>
          <p className={`muted${error ? " lp-prompt-error" : ""}`}>
            {error ?? "Preparing your progress view."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <ProgressView
      run={payload.run}
      stages={payload.stages}
      stageItems={payload.stageItems}
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
