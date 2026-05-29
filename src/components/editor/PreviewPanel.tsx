import dynamic from "next/dynamic";
import { DurationPolicy, DURATION_POLICIES } from "@/lib/audio-alignment";
import { Clip, Project, Timeline, timelineDurationSec } from "@/lib/types";
import { ExportResult } from "./types";

const Preview = dynamic(() => import("../Preview"), { ssr: false });

const DURATION_POLICY_LABELS: Record<DurationPolicy, string> = {
  timeline_only: "Timeline only (may cut audio)",
  match_longest_media: "Match longest media (keep audio whole)",
  fail_on_mismatch: "Fail on mismatch (require alignment)",
};

interface PreviewPanelProps {
  audioClips: Clip[];
  busy: boolean;
  durationPolicy: DurationPolicy;
  exportResult: ExportResult | null;
  project: Project | null;
  selectedAudioClipId: string;
  setDurationPolicy: (value: DurationPolicy) => void;
  setSelectedAudioClipId: (value: string) => void;
  timeline: Timeline | null;
  clips: Clip[];
  onAlignAudio: (strategy: "rewrite_script" | "extend_timeline") => void;
  onExport: () => void;
}

export function PreviewPanel({
  audioClips,
  busy,
  durationPolicy,
  exportResult,
  project,
  selectedAudioClipId,
  setDurationPolicy,
  setSelectedAudioClipId,
  timeline,
  clips,
  onAlignAudio,
  onExport,
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

      {project?.plan && (
        <div style={{ alignSelf: "stretch", marginTop: 20 }}>
          <h2>Edit plan</h2>
          <div className="muted" style={{ marginBottom: 6 }}>
            {project.plan.style} · {project.plan.targetLengthSec}s
          </div>
          {project.plan.beats.map((beat, index) => (
            <span className="pill" key={index}>
              {beat.name} ~{beat.durationSec}s
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
