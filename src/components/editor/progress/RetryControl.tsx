"use client";

// Retry control surfaced on failed stages and stage items (PR #8).
//
// "Retryable failures expose a retry action" — a failure is retryable when the
// backend marks `error.retryable` true or the stage/item carries
// `retryable: true`. Non-retryable failures still render the button but
// disable it with an explanatory tooltip so users understand why they cannot
// recover from this state in-place.
//
// Lives standalone until PR #6 builds the progress shell that will mount it on
// each failed stage card.

import React, { useState } from "react";
import {
  GenerationRunClient,
  GenerationRunRequestError,
  RetryGenerationRunOptions,
} from "@/lib/v1/generation-runs/client";
import {
  GenerationRun,
  GenerationStage,
  GenerationStageItem,
} from "@/lib/v1/types";

export interface RetryControlProps {
  projectId: string;
  run: Pick<GenerationRun, "runId" | "status" | "error">;
  // Pass a stage to retry that stage; pass an item to retry that item; pass
  // neither to retry whichever failed scope the backend decides on.
  stage?: Pick<GenerationStage, "stageId" | "status" | "error">;
  item?: Pick<GenerationStageItem, "itemId" | "status" | "retryable" | "error">;
  client: GenerationRunClient;
  onRetried?: () => void;
  // Optional override label, eg. "Retry narration".
  label?: string;
}

export function RetryControl(props: RetryControlProps): JSX.Element | null {
  const { projectId, run, stage, item, client, onRetried, label } = props;
  const [pending, setPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | undefined>();

  const scope = pickScope(run, stage, item);
  if (!scope.visible) return null;

  const handleRetry = async () => {
    setPending(true);
    setErrorMessage(undefined);
    try {
      const options: RetryGenerationRunOptions = {};
      if (stage) options.stageId = stage.stageId;
      if (item) options.itemId = item.itemId;
      await client.retryRun(projectId, run.runId, options);
      onRetried?.();
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
        disabled={pending || !scope.enabled}
        onClick={handleRetry}
        title={scope.disabledReason}
        aria-disabled={pending || !scope.enabled}
      >
        {pending ? "Retrying…" : label ?? "Retry"}
      </button>
      {errorMessage && (
        <span className="muted" role="alert" style={{ fontSize: 12 }}>
          {errorMessage}
        </span>
      )}
    </div>
  );
}

interface RetryScope {
  visible: boolean;
  enabled: boolean;
  disabledReason?: string;
}

function pickScope(
  run: RetryControlProps["run"],
  stage: RetryControlProps["stage"],
  item: RetryControlProps["item"],
): RetryScope {
  if (item) {
    if (item.status !== "failed") return { visible: false, enabled: false };
    const retryable = item.retryable ?? item.error?.retryable ?? false;
    return {
      visible: true,
      enabled: retryable,
      disabledReason: retryable ? undefined : "This item cannot be retried automatically.",
    };
  }
  if (stage) {
    if (stage.status !== "failed") return { visible: false, enabled: false };
    const retryable = stage.error?.retryable ?? false;
    return {
      visible: true,
      enabled: retryable,
      disabledReason: retryable
        ? undefined
        : "This stage cannot be retried — restart the run instead.",
    };
  }
  if (run.status !== "failed") return { visible: false, enabled: false };
  const retryable = run.error?.retryable ?? true;
  return {
    visible: true,
    enabled: retryable,
    disabledReason: retryable ? undefined : "This run cannot be retried automatically.",
  };
}

function messageFor(err: unknown): string {
  if (err instanceof GenerationRunRequestError) {
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return "Retry failed.";
}
