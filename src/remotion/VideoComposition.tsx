import React from "react";
import { AbsoluteFill, Img, OffthreadVideo, Sequence } from "remotion";
import { Clip, Timeline } from "../lib/types";

export interface VideoProps {
  timeline: Timeline | null;
  clips: Clip[];
  baseUrl: string;
}

// Renders the structured timeline to actual frames. Each segment is one
// trimmed clip placed sequentially. This same component powers both the
// in-browser <Player> preview and the server-side MP4 render.
export const VideoComposition: React.FC<VideoProps> = ({
  timeline,
  clips,
  baseUrl,
}) => {
  if (!timeline || timeline.segments.length === 0) {
    return <AbsoluteFill style={{ backgroundColor: "#000" }} />;
  }

  const fps = timeline.fps || 30;
  const byId = Object.fromEntries(clips.map((c) => [c.id, c]));
  let cursor = 0;

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {timeline.segments.map((seg) => {
        const clip = byId[seg.clipId];
        if (!clip) return null;
        const segFrames = Math.max(
          1,
          Math.round((seg.sourceOutSec - seg.sourceInSec) * fps)
        );
        const from = cursor;
        cursor += segFrames;
        const src = clip.url.startsWith("http")
          ? clip.url
          : `${baseUrl}${clip.url}`;

        return (
          <Sequence key={seg.id} from={from} durationInFrames={segFrames}>
            <AbsoluteFill>
              {(clip.kind || "video") === "image" ? (
                <Img
                  src={src}
                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                />
              ) : (
                <OffthreadVideo
                  src={src}
                  startFrom={Math.round(seg.sourceInSec * fps)}
                  endAt={Math.round(seg.sourceOutSec * fps)}
                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                />
              )}
            </AbsoluteFill>
            {seg.caption ? (
              <AbsoluteFill
                style={{
                  justifyContent: "flex-end",
                  alignItems: "center",
                  padding: 48,
                }}
              >
                <div
                  style={{
                    background: "rgba(0,0,0,0.6)",
                    color: "#fff",
                    fontSize: 56,
                    fontWeight: 700,
                    fontFamily: "Arial, sans-serif",
                    padding: "12px 24px",
                    borderRadius: 12,
                    textAlign: "center",
                    maxWidth: "90%",
                  }}
                >
                  {seg.caption}
                </div>
              </AbsoluteFill>
            ) : null}
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
