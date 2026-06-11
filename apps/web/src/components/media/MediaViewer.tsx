import { useCallback, useEffect, useRef, useState } from "react";
import type { AssetKind } from "@popcorn/shared/v1/types";
import styles from "./MediaViewer.module.css";

export interface MediaViewerItem {
  id: string;
  kind: AssetKind;
  title: string;
  url?: string | null;
  thumbnailUrl?: string | null;
  filename?: string | null;
  projectName?: string | null;
  durationSec?: number | null;
  expiresAt?: string | null;
}

export interface RefreshedMediaUrls {
  url: string | null;
  thumbnailUrl?: string | null;
  expiresAt?: string | null;
}

export interface MediaViewerProps {
  item: MediaViewerItem | null;
  hasPrevious?: boolean;
  hasNext?: boolean;
  onClose: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
  onRefresh?: (item: MediaViewerItem) => Promise<RefreshedMediaUrls>;
}

function formatDuration(seconds?: number | null) {
  if (!Number.isFinite(seconds ?? NaN)) return null;
  const totalSeconds = Math.max(0, Math.round(seconds ?? 0));
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function isNearExpiry(expiresAt?: string | null) {
  if (!expiresAt) return false;
  const expires = new Date(expiresAt).getTime();
  return Number.isFinite(expires) && expires - Date.now() < 60_000;
}

export function MediaViewer({
  item,
  hasPrevious = false,
  hasNext = false,
  onClose,
  onPrevious,
  onNext,
  onRefresh,
}: MediaViewerProps) {
  const [media, setMedia] = useState<MediaViewerItem | null>(item);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const lastRefreshIdRef = useRef<string | null>(null);

  useEffect(() => {
    setMedia(item);
    setRefreshError(null);
    lastRefreshIdRef.current = null;
  }, [item]);

  const refresh = useCallback(async () => {
    if (!media || !onRefresh || refreshing) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      const next = await onRefresh(media);
      setMedia((current) =>
        current && current.id === media.id
          ? {
              ...current,
              url: next.url,
              thumbnailUrl: next.thumbnailUrl ?? current.thumbnailUrl,
              expiresAt: next.expiresAt ?? current.expiresAt,
            }
          : current
      );
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : "Unable to refresh media URL.");
    } finally {
      setRefreshing(false);
    }
  }, [media, onRefresh, refreshing]);

  useEffect(() => {
    if (!media || !onRefresh || !isNearExpiry(media.expiresAt)) return;
    if (lastRefreshIdRef.current === media.id) return;
    lastRefreshIdRef.current = media.id;
    void refresh();
  }, [media, onRefresh, refresh]);

  useEffect(() => {
    if (!media) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft" && hasPrevious) onPrevious?.();
      if (event.key === "ArrowRight" && hasNext) onNext?.();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [hasNext, hasPrevious, media, onClose, onNext, onPrevious]);

  if (!media) return null;

  const title = media.title || media.filename || media.id;
  const duration = formatDuration(media.durationSec);
  const canRender = Boolean(media.url || media.thumbnailUrl);

  const handleMediaError = () => {
    if (!onRefresh || lastRefreshIdRef.current === media.id) return;
    lastRefreshIdRef.current = media.id;
    void refresh();
  };

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label={title}>
      <button className={styles.backdrop} type="button" aria-label="Close media viewer" onClick={onClose} />
      <section className={styles.dialog}>
        <header className={styles.header}>
          <div className={styles.titleBlock}>
            <h2>{title}</h2>
            <div className={styles.meta}>
              <span>{media.kind}</span>
              {duration ? <span>{duration}</span> : null}
              {media.projectName ? <span>{media.projectName}</span> : null}
            </div>
          </div>
          <button className={styles.iconButton} type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className={styles.stage}>
          {hasPrevious ? (
            <button className={`${styles.navButton} ${styles.prevButton}`} type="button" onClick={onPrevious} aria-label="Previous media">
              ‹
            </button>
          ) : null}

          {canRender && media.kind === "image" ? (
            <img className={styles.visualMedia} src={media.url ?? media.thumbnailUrl ?? undefined} alt={title} onError={handleMediaError} />
          ) : null}
          {canRender && media.kind === "video" ? (
            <video className={styles.visualMedia} src={media.url ?? undefined} poster={media.thumbnailUrl ?? undefined} controls preload="metadata" onError={handleMediaError} />
          ) : null}
          {canRender && media.kind === "audio" ? (
            <div className={styles.audioPanel}>
              <div className={styles.audioGlyph}>Audio</div>
              <audio src={media.url ?? undefined} controls preload="metadata" onError={handleMediaError} />
            </div>
          ) : null}
          {!canRender ? (
            <div className={styles.emptyState}>
              <strong>No playable URL</strong>
              <span>This asset is not viewable until the API projects a signed media URL.</span>
            </div>
          ) : null}

          {hasNext ? (
            <button className={`${styles.navButton} ${styles.nextButton}`} type="button" onClick={onNext} aria-label="Next media">
              ›
            </button>
          ) : null}
        </div>

        {(refreshing || refreshError) ? (
          <div className={styles.status} role={refreshError ? "alert" : "status"}>
            {refreshing ? "Refreshing media URL..." : refreshError}
          </div>
        ) : null}
      </section>
    </div>
  );
}
