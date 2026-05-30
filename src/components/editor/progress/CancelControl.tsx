"use client";

// Cancel control for active runs (PR #8).
//
// "Cancelable active runs expose a cancel action" — the button is rendered
// only while the run is queued or running. Confirmation is required because
// canceling discards in-flight provider work that may have already incurred
// cost. If the backend returns `job_not_cancelable` the cancel button hides
// itself on the next poll once the parent component refreshes.

import React, { useState } from "react";
import {
  GenerationRunClient,
  GenerationRunRequestError,
} from "@/lib/v1/generation-runs/client";
import { GenerationRun } from "@/lib/v1/types";
import { isRunActive } from "@/lib/v1/generation-runs/status";

export interface CancelControlProps {
  projectId: string;
  run: Pick<GenerationRun, "runId" | "status">;
  client: GenerationRunClient;
  onCanceled?: () => void;
  // Optional confirmation hook for tests; defaults to window.confirm.
  confirm?: (message: string) => boolean;
}

const CONFIRM_MESSAGE =
  "Cancel this generation? Any in-progress provider work will stop.";

export function CancelControl(props: CancelControlProps): JSX.Element | null {
  const { projectId, run, client, onCanceled, confirm } = props;
  const [pending, setPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | undefined>();

  if (!isRunActive(run.status)) return null;

  const handleCancel = async () => {
    const ask = confirm ?? defaultConfirm;
    if (!ask(CONFIRM_MESSAGE)) return;

    setPending(true);
    setErrorMessage(undefined);
    try {
      await client.cancelRun(projectId, run.runId);
      onCanceled?.();
    } catch (err) {
      setErrorMessage(messageFor(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="row" style={{ gap: 8, alignItems: "center" }}>
      <button
        type="button"
        className="secondary compact"
        disabled={pending}
        onClick={handleCancel}
        aria-disabled={pending}
      >
        {pending ? "Canceling…" : "Cancel generation"}
      </button>
      {errorMessage && (
        <span className="muted" role="alert" style={{ fontSize: 12 }}>
          {errorMessage}
        </span>
      )}
    </div>
  );
}

function defaultConfirm(message: string): boolean {
  if (typeof window === "undefined") return true;
  return window.confirm(message);
}

function messageFor(err: unknown): string {
  if (err instanceof GenerationRunRequestError) {
    if (err.code === "job_not_cancelable") {
      return "This run can no longer be canceled.";
    }
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return "Cancel failed.";
}
