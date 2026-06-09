import { useMemo, useState } from "react";
import {
  type Clip,
  type Timeline,
  type TimelineSegment,
  segmentDurationSec,
} from "@popcorn/shared/types";
import styles from "./TimelinePanel.module.css";

interface TimelinePanelProps {
  timeline: Timeline;
  clips: Clip[];
}

interface EditableSegment {
  caption: string;
  note: string;
}

function segmentLabel(segment: TimelineSegment, clip?: Clip): string {
  return clip?.filename || segment.clipId;
}

export function TimelinePanel({ timeline, clips }: TimelinePanelProps) {
  const [edits, setEdits] = useState<Record<string, EditableSegment>>({});
  const clipById = useMemo(
    () => Object.fromEntries(clips.map((clip) => [clip.id, clip])),
    [clips],
  );

  function updateSegment(segmentId: string, patch: Partial<EditableSegment>) {
    setEdits((current) => ({
      ...current,
      [segmentId]: {
        caption: current[segmentId]?.caption ?? "",
        note: current[segmentId]?.note ?? "",
        ...patch,
      },
    }));
  }

  return (
    <aside className={styles.panel} aria-label="Timeline editor">
      <div className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Timeline</p>
          <h3 className={styles.title}>Editable rough cut</h3>
        </div>
        <span className={styles.meta}>
          {timeline.segments.length} segments · {timeline.aspectRatio}
        </span>
      </div>

      <ol className={styles.segmentList}>
        {timeline.segments.map((segment, index) => {
          const clip = clipById[segment.clipId];
          const draft = edits[segment.id];
          return (
            <li className={styles.segment} key={segment.id}>
              <span className={styles.index}>{index + 1}</span>
              <div className={styles.segmentBody}>
                <div className={styles.segmentTop}>
                  <strong>{segment.role}</strong>
                  <span>{segmentDurationSec(segment).toFixed(1)}s</span>
                </div>
                <p className={styles.clipName}>{segmentLabel(segment, clip)}</p>
                <div className={styles.trim}>
                  <span>In {segment.sourceInSec.toFixed(1)}s</span>
                  <span>Out {segment.sourceOutSec.toFixed(1)}s</span>
                </div>
                {segment.reason ? <p className={styles.reason}>{segment.reason}</p> : null}
                <label className={styles.field}>
                  <span>Caption</span>
                  <input
                    value={draft?.caption ?? segment.caption ?? ""}
                    onChange={(event) =>
                      updateSegment(segment.id, { caption: event.target.value })
                    }
                    placeholder="Add or edit caption text"
                  />
                </label>
                <label className={styles.field}>
                  <span>Scene note</span>
                  <textarea
                    value={draft?.note ?? ""}
                    onChange={(event) =>
                      updateSegment(segment.id, { note: event.target.value })
                    }
                    placeholder="What should change in this scene?"
                    rows={2}
                  />
                </label>
              </div>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}
