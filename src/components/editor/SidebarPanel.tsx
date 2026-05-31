import React from "react";
import {
  Clip,
  Project,
  Timeline,
  segmentDurationSec,
} from "@/lib/types";

interface SidebarPanelProps {
  clipById: Record<string, Clip>;
  message: string;
  project: Project | null;
  setMessage: (value: string) => void;
  timeline: Timeline | null;
  busy: boolean;
  onRevise: () => void;
}

export function SidebarPanel({
  clipById,
  message,
  project,
  setMessage,
  timeline,
  busy,
  onRevise,
}: SidebarPanelProps) {
  return (
    <div className="col">
      <h2>Timeline</h2>
      {!timeline && <p className="muted">Generate a cut to see the timeline.</p>}
      {timeline &&
        timeline.segments.map((segment, index) => (
          <div className="segment" key={segment.id}>
            <span className="idx">{index + 1}</span>
            <div style={{ minWidth: 0 }}>
              <div>
                <b>{segment.role}</b> · {clipById[segment.clipId]?.filename || segment.clipId} ·{" "}
                {segmentDurationSec(segment).toFixed(1)}s
              </div>
              <div className="muted">
                in {segment.sourceInSec.toFixed(1)}s → out {segment.sourceOutSec.toFixed(1)}s
              </div>
              {segment.reason && <div className="muted">{segment.reason}</div>}
            </div>
          </div>
        ))}

      {project?.critic && (
        <>
          <h2>Critic</h2>
          <div className="scores">
            {Object.entries(project.critic.scores).map(([key, value]) => (
              <div className="score" key={key}>
                <span className="muted">{key.replace(/_/g, " ")}</span>
                <b>{value}</b>
              </div>
            ))}
          </div>
          <p className="muted" style={{ marginTop: 8 }}>
            {project.critic.summary}
          </p>
        </>
      )}

      <h2>Revise (chat)</h2>
      <div className="chat">
        {(project?.chat ?? []).length === 0 && (
          <p className="muted">
            Ask for changes: “make it punchier”, “use less talking head”, “shorten
            to 15s”, “add captions”.
          </p>
        )}
        {(project?.chat ?? []).map((item, index) => (
          <div className={`msg ${item.role}`} key={index}>
            {item.content}
          </div>
        ))}
      </div>
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Make the hook punchier and add captions…"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onRevise();
        }}
      />
      <div style={{ marginTop: 8 }}>
        <button onClick={onRevise} disabled={busy || !timeline}>
          Send revision
        </button>
      </div>
    </div>
  );
}
