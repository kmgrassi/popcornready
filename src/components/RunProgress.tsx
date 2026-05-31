"use client";

import React, { useEffect, useRef, useState } from "react";

import { ProgressView } from "@/components/progress/ProgressView";
import { GenerationRun, GenerationStage } from "@/lib/v1/types";

const POLL_INTERVAL_MS = 2000;

interface GenerationRunPayload {
  run: GenerationRun;
  stages: GenerationStage[];
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
  const readyFired = useRef(false);

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
        timer = setTimeout(poll, POLL_INTERVAL_MS);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        timer = setTimeout(poll, POLL_INTERVAL_MS * 2);
      }
    }

    void poll();

    function onVisibilityChange() {
      if (document.visibilityState !== "visible") return;
      if (timer) clearTimeout(timer);
      void poll();
    }

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [projectId, runId, onReady]);

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

  return <ProgressView run={payload.run} stages={payload.stages} />;
}
