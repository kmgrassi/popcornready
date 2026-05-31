import React from "react";
import { Clip, EditPlan, Timeline, timelineDurationSec } from "@/lib/types";
import { DURATION_POLICIES, DurationPolicy } from "@/lib/audio-alignment";
import {
  CreatedVideo,
  DURATION_POLICY_LABELS,
  ExportResult,
  formatBytes,
  formatCreatedAt,
} from "./shared";

interface PreviewPanelProps {
  Preview: React.ComponentType<{ timeline: Timeline | null; clips: Clip[] }>;
  audioClips: Clip[];
  busy: boolean;
  createdVideos: CreatedVideo[];
  durationPolicy: DurationPolicy;
  exportResult: ExportResult | null;
  galleryLoading: boolean;
  loadedVideoThumbs: Record<string, boolean>;
  plan?: EditPlan;
  selectedAudioClipId: string;
  setDurationPolicy: (value: DurationPolicy) => void;
  setLoadedVideoThumbs: React.Dispatch<
    React.SetStateAction<Record<string, boolean>>
  >;
  setSelectedAudioClipId: (value: string) => void;
  timeline: Timeline | null;
  clips: Clip[];
  onAlignAudio: (strategy: "rewrite_script" | "extend_timeline") => void;
  onExport: () => void;
  onRefreshCreatedVideos: () => void;
}

export function PreviewPanel({
  Preview,
  audioClips,
  busy,
  createdVideos,
  durationPolicy,
  exportResult,
  galleryLoading,
  loadedVideoThumbs,
  plan,
  selectedAudioClipId,
  setDurationPolicy,
  setLoadedVideoThumbs,
  setSelectedAudioClipId,
  timeline,
  clips,
  onAlignAudio,
  onExport,
  onRefreshCreatedVideos,
}: PreviewPanelProps) {
  return (
    <div className="col center">
      <h2 style={{ alignSelf: "flex-start" }}>Preview</h2>
      <Preview timeline={timeline} clips={clips} />
      {timeline && timeline.segments.length > 0 && (
        <div style={{ marginTop: 12, textAlign: "center" }}>
          <div className="muted" style={{ marginBottom: 8 }}>
            {timeline.segments.length} segments ·{" "}
            {timelineDurationSec(timeline).toFixed(1)}s · {timeline.aspectRatio}
          </div>
          {audioClips.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <label style={{ textAlign: "left" }}>Audio overlay</label>
              <select
                value={selectedAudioClipId}
                onChange={(e) => setSelectedAudioClipId(e.target.value)}
              >
                <option value="">None</option>
                {audioClips.map((clip) => (
                  <option key={clip.id} value={clip.id}>
                    {clip.filename}
                  </option>
                ))}
              </select>
            </div>
          )}
          {audioClips.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <label style={{ textAlign: "left" }}>Audio duration policy</label>
              <select
                value={durationPolicy}
                onChange={(e) => setDurationPolicy(e.target.value as DurationPolicy)}
              >
                {DURATION_POLICIES.map((policy) => (
                  <option key={policy} value={policy}>
                    {DURATION_POLICY_LABELS[policy]}
                  </option>
                ))}
              </select>
              {selectedAudioClipId && (
                <div
                  style={{
                    marginTop: 6,
                    display: "flex",
                    gap: 8,
                    justifyContent: "center",
                  }}
                >
                  <button
                    className="secondary"
                    onClick={() => onAlignAudio("rewrite_script")}
                    disabled={busy}
                  >
                    Align: rewrite narration
                  </button>
                  <button
                    className="secondary"
                    onClick={() => onAlignAudio("extend_timeline")}
                    disabled={busy}
                  >
                    Align: extend timeline
                  </button>
                </div>
              )}
            </div>
          )}
          <button className="secondary" onClick={onExport} disabled={busy}>
            Export MP4
          </button>
          {exportResult && (
            <div style={{ marginTop: 10 }}>
              <a href={exportResult.url} target="_blank" rel="noreferrer">
                Download render
              </a>
              {exportResult.overlayUrl && exportResult.silentUrl && (
                <div className="muted" style={{ marginTop: 8 }}>
                  <a href={exportResult.silentUrl} target="_blank" rel="noreferrer">
                    Silent video
                  </a>
                  {" · "}
                  <a href={exportResult.overlayUrl} target="_blank" rel="noreferrer">
                    Video + audio overlay
                  </a>
                </div>
              )}
              {exportResult.alignment &&
                exportResult.alignment.comparison.audioDurationSec > 0 && (
                  <div className="muted" style={{ marginTop: 8 }}>
                    {exportResult.alignment.policy} · export{" "}
                    {exportResult.alignment.exportDurationSec.toFixed(1)}s · audio{" "}
                    {exportResult.alignment.comparison.audioDurationSec.toFixed(1)}s
                    {" · Δ"}
                    {exportResult.alignment.comparison.deltaSec.toFixed(1)}s
                    {exportResult.alignment.warning && (
                      <div style={{ color: "#b45309", marginTop: 4 }}>
                        {exportResult.alignment.warning}
                      </div>
                    )}
                  </div>
                )}
            </div>
          )}
        </div>
      )}
      {plan && (
        <div style={{ alignSelf: "stretch", marginTop: 20 }}>
          <h2>Edit plan</h2>
          <div className="muted" style={{ marginBottom: 6 }}>
            {plan.style} · {plan.targetLengthSec}s
          </div>
          {plan.beats.map((beat, index) => (
            <span className="pill" key={index}>
              {beat.name} ~{beat.durationSec}s
            </span>
          ))}
        </div>
      )}
      <section className="video-gallery" aria-label="Created videos">
        <div className="gallery-head">
          <div>
            <h2>Created videos</h2>
            <p className="sub">Local renders from this workspace, newest first.</p>
          </div>
          <button
            className="secondary compact"
            onClick={onRefreshCreatedVideos}
            disabled={galleryLoading}
          >
            Refresh
          </button>
        </div>
        {galleryLoading && createdVideos.length === 0 ? (
          <div className="video-grid" aria-hidden="true">
            {Array.from({ length: 8 }).map((_, index) => (
              <div className="video-tile skeleton-tile" key={index}>
                <div className="thumb-skeleton" />
                <div className="meta-skeleton wide" />
                <div className="meta-skeleton" />
              </div>
            ))}
          </div>
        ) : createdVideos.length === 0 ? (
          <div className="gallery-empty">
            <div>No rendered videos yet.</div>
            <span>Export an MP4 and it will appear here.</span>
          </div>
        ) : (
          <div className="video-grid">
            {createdVideos.map((video) => (
              <article className="video-tile" key={video.url}>
                <a href={video.url} target="_blank" rel="noreferrer">
                  {!loadedVideoThumbs[video.url] && (
                    <div className="thumb-skeleton overlay" />
                  )}
                  <video
                    src={video.url}
                    muted
                    playsInline
                    preload="metadata"
                    className={loadedVideoThumbs[video.url] ? "thumb-ready" : ""}
                    onLoadedData={() =>
                      setLoadedVideoThumbs((prev) => ({
                        ...prev,
                        [video.url]: true,
                      }))
                    }
                    onMouseEnter={(e) => e.currentTarget.play().catch(() => {})}
                    onMouseLeave={(e) => {
                      e.currentTarget.pause();
                      e.currentTarget.currentTime = 0;
                    }}
                  />
                  <div className="video-shade" />
                  <div className="video-badge">
                    {video.hasAudioOverlay ? "Audio" : "Silent"}
                  </div>
                </a>
                <div className="video-meta">
                  <div className="video-title">{video.filename}</div>
                  <div className="muted">
                    {video.durationSec ? `${video.durationSec.toFixed(1)}s · ` : ""}
                    {formatBytes(video.sizeBytes)} · {formatCreatedAt(video.createdAt)}
                  </div>
                  <div className="video-links">
                    <a href={video.url} target="_blank" rel="noreferrer">
                      Open
                    </a>
                    {video.silentUrl && video.overlayUrl && (
                      <>
                        <span>·</span>
                        <a href={video.silentUrl} target="_blank" rel="noreferrer">
                          Silent
                        </a>
                      </>
                    )}
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
