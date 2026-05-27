"use client";

import React from "react";
import { Player } from "@remotion/player";
import { VideoComposition } from "@/remotion/VideoComposition";
import { Clip, Timeline, dims, timelineDurationSec } from "@/lib/types";

export default function Preview({
  timeline,
  clips,
}: {
  timeline: Timeline | null;
  clips: Clip[];
}) {
  if (!timeline || timeline.segments.length === 0) {
    return (
      <div className="player-wrap" style={{ aspectRatio: "9/16" }}>
        <div
          style={{
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--muted)",
            padding: 24,
            textAlign: "center",
          }}
        >
          Your AI rough cut will preview here once generated.
        </div>
      </div>
    );
  }

  const fps = timeline.fps || 30;
  const { width, height } = dims(timeline.aspectRatio);
  const durationInFrames = Math.max(
    1,
    Math.round(timelineDurationSec(timeline) * fps)
  );

  return (
    <div className="player-wrap">
      <Player
        component={VideoComposition as React.FC}
        inputProps={{ timeline, clips, baseUrl: "" }}
        durationInFrames={durationInFrames}
        fps={fps}
        compositionWidth={width}
        compositionHeight={height}
        style={{ width: "100%" }}
        controls
        loop
      />
    </div>
  );
}
