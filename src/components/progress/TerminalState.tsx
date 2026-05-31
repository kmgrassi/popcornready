"use client";

import { GenerationRun } from "@/lib/v1/types";
import { formatElapsed, useElapsedTime } from "./useElapsedTime";

interface TerminalStateProps {
  run: GenerationRun;
}

export function TerminalState({ run }: TerminalStateProps) {
  const elapsed = useElapsedTime(run.startedAt, run.completedAt);

  if (run.status === "succeeded") {
    return (
      <div className="terminal-state terminal-succeeded" role="status">
        <div className="terminal-state-head">
          <span className="terminal-state-glyph" aria-hidden>✓</span>
          <span className="terminal-state-heading">Your video is ready</span>
        </div>
        <p className="terminal-state-message">
          {run.message ??
            "Generation finished. The final preview is available below."}
        </p>
        {elapsed !== null ? (
          <p className="terminal-state-meta">
            Completed in {formatElapsed(elapsed)}.
          </p>
        ) : null}
      </div>
    );
  }

  if (run.status === "failed") {
    return (
      <div className="terminal-state terminal-failed" role="alert">
        <div className="terminal-state-head">
          <span className="terminal-state-glyph" aria-hidden>!</span>
          <span className="terminal-state-heading">Generation failed</span>
        </div>
        <p className="terminal-state-message">
          {run.error?.message ??
            run.message ??
            "Something went wrong while generating your video."}
        </p>
        {run.error?.code ? (
          <p className="terminal-state-meta">
            Error: <code>{run.error.code}</code>
            {elapsed !== null ? ` · Stopped after ${formatElapsed(elapsed)}.` : null}
          </p>
        ) : elapsed !== null ? (
          <p className="terminal-state-meta">
            Stopped after {formatElapsed(elapsed)}.
          </p>
        ) : null}
        {run.error?.retryable ? (
          <p className="terminal-state-meta muted">
            This stage can be retried.
          </p>
        ) : null}
      </div>
    );
  }

  if (run.status === "canceled") {
    return (
      <div className="terminal-state terminal-canceled" role="status">
        <div className="terminal-state-head">
          <span className="terminal-state-glyph" aria-hidden>—</span>
          <span className="terminal-state-heading">Run canceled</span>
        </div>
        <p className="terminal-state-message">
          {run.message ?? "This generation run was canceled."}
        </p>
        {elapsed !== null ? (
          <p className="terminal-state-meta">
            Stopped after {formatElapsed(elapsed)}.
          </p>
        ) : null}
      </div>
    );
  }

  return null;
}
