"use client";

import React from "react";
import type {
  GenerationRunStatus,
  GenerationStageItem,
} from "@/lib/v1/types";

type StageItemKind = GenerationStageItem["kind"];

// Caller-resolved view of the artifact an item is rendering. Stage items
// reference assets/artifacts by id; the parent resolves the id to a URL or
// text payload and passes the result in. Keeping the card storage-neutral
// means it works the same whether the asset lives on disk or in S3.
export interface StageItemAsset {
  url?: string;
  mimeType?: string;
  thumbnailUrl?: string;
  durationSec?: number;
  text?: string;
}

export interface StageItemCardProps {
  item: GenerationStageItem;
  asset?: StageItemAsset;
  // Optional short status line shown under the progress bar while running.
  // GenerationStageItem itself has no message field; the parent owns this
  // text (typically derived from the matching Job's JobProgress.message).
  statusMessage?: string;
  onRetry?: (item: GenerationStageItem) => void;
}

const KIND_LABEL: Record<StageItemKind, string> = {
  image: "Image",
  video: "Video",
  audio: "Audio",
  caption: "Caption",
  timeline: "Timeline",
  export: "Export",
};

const STATUS_LABEL: Record<GenerationRunStatus, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Ready",
  failed: "Failed",
  canceled: "Canceled",
};

function StatusPill({ status }: { status: GenerationRunStatus }) {
  return (
    <span className={`status-pill ${status}`}>{STATUS_LABEL[status]}</span>
  );
}

function KindBadge({ kind }: { kind: StageItemKind }) {
  return <span className="kind-badge">{KIND_LABEL[kind]}</span>;
}

function isBarKind(kind: StageItemKind): boolean {
  return kind === "audio" || kind === "caption" || kind === "timeline";
}

function Skeleton({ kind }: { kind: StageItemKind }) {
  return <div className={`thumb-skeleton${isBarKind(kind) ? " bar" : ""}`} />;
}

function ProgressBar({ percent }: { percent?: number }) {
  const determinate = typeof percent === "number" && Number.isFinite(percent);
  const clamped = determinate ? Math.max(0, Math.min(100, percent as number)) : 0;
  return (
    <div
      className={`progress-bar ${determinate ? "determinate" : "indeterminate"}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={determinate ? clamped : undefined}
    >
      <div
        className="progress-bar-fill"
        style={determinate ? { width: `${clamped}%` } : undefined}
      />
    </div>
  );
}

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

function MediaFrame({
  item,
  asset,
}: {
  item: GenerationStageItem;
  asset?: StageItemAsset;
}) {
  if (!asset?.url) {
    return <div className="media-frame placeholder" aria-hidden="true" />;
  }
  if (item.kind === "image") {
    return (
      <div className="media-frame">
        <img src={asset.url} alt={item.label} />
      </div>
    );
  }
  return (
    <div className="media-frame">
      <video
        src={asset.url}
        poster={asset.thumbnailUrl}
        controls
        muted
        playsInline
        preload="metadata"
      />
    </div>
  );
}

function CompletedBody({
  item,
  asset,
}: {
  item: GenerationStageItem;
  asset?: StageItemAsset;
}) {
  switch (item.kind) {
    case "image":
    case "video":
    case "export":
      return <MediaFrame item={item} asset={asset} />;
    case "audio":
      return (
        <div className="audio-player">
          {asset?.url ? (
            <audio src={asset.url} controls preload="metadata" />
          ) : (
            <span className="muted">Audio ready.</span>
          )}
          {typeof asset?.durationSec === "number" && (
            <span className="muted duration">
              {formatDuration(asset.durationSec)}
            </span>
          )}
        </div>
      );
    case "caption":
      return (
        <div className="text-preview caption">
          {asset?.text ?? <span className="muted">Captions ready.</span>}
        </div>
      );
    case "timeline":
      return (
        <div className="text-preview timeline">
          {asset?.text ?? <span className="muted">Timeline ready.</span>}
        </div>
      );
    default:
      return null;
  }
}

export function StageItemCard({
  item,
  asset,
  statusMessage,
  onRetry,
}: StageItemCardProps) {
  const canRetry =
    item.status === "failed" && item.retryable === true && !!onRetry;

  return (
    <article
      className={`stage-item-card ${item.status}`}
      data-kind={item.kind}
      data-status={item.status}
    >
      <header className="stage-item-card-head">
        <div className="stage-item-card-head-left">
          <KindBadge kind={item.kind} />
          <h3 className="stage-item-card-label" title={item.label}>
            {item.label}
          </h3>
        </div>
        <StatusPill status={item.status} />
      </header>

      {item.status === "queued" && (
        <div className="stage-item-card-body queued">
          <Skeleton kind={item.kind} />
          <p className="muted small">Waiting for capacity.</p>
        </div>
      )}

      {item.status === "running" && (
        <div className="stage-item-card-body running">
          <Skeleton kind={item.kind} />
          <ProgressBar percent={item.progressPercent} />
          {(item.provider || statusMessage) && (
            <p className="stage-item-card-status-line">
              {item.provider && (
                <span className="provider">{item.provider}</span>
              )}
              {item.provider && statusMessage && (
                <span className="dot" aria-hidden="true">
                  ·
                </span>
              )}
              {statusMessage && (
                <span className="message">{statusMessage}</span>
              )}
            </p>
          )}
          {item.promptPreview && (
            <p className="prompt-preview" title={item.promptPreview}>
              &ldquo;{item.promptPreview}&rdquo;
            </p>
          )}
        </div>
      )}

      {item.status === "succeeded" && (
        <div className="stage-item-card-body succeeded">
          <CompletedBody item={item} asset={asset} />
        </div>
      )}

      {item.status === "failed" && (
        <div className="stage-item-card-body failed">
          <div className="stage-item-error" role="alert">
            <span className="error-code">{item.error?.code ?? "error"}</span>
            <span className="error-message">
              {item.error?.message ?? "This item failed."}
            </span>
          </div>
          {canRetry && (
            <button
              type="button"
              className="secondary compact stage-item-retry"
              onClick={() => onRetry!(item)}
            >
              Retry
            </button>
          )}
        </div>
      )}

      {item.status === "canceled" && (
        <div className="stage-item-card-body canceled">
          <span className="muted">Canceled before completion.</span>
        </div>
      )}
    </article>
  );
}

export default StageItemCard;
