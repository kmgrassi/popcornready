"use client";

import React from "react";
import { Player } from "@remotion/player";
import { VideoComposition } from "@/remotion/VideoComposition";
import { createRenderPlanFromTimeline } from "@/lib/render-plan";
import { Clip, Timeline } from "@/lib/types";

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

  const { renderPlan } = createRenderPlanFromTimeline({ timeline });
  const durationInFrames = Math.max(
    1,
    Math.round(renderPlan.durationSec * renderPlan.output.fps)
  );
  const audioClipIds = clips
    .filter((clip) => clip.kind === "audio")
    .map((clip) => clip.id);

  return (
    <div className="player-wrap">
      <Player
        component={VideoComposition as React.FC}
        inputProps={{
          timeline,
          renderPlan,
          clips,
          baseUrl: "",
          includeAudio: audioClipIds.length > 0,
          audioClipIds,
        }}
        durationInFrames={durationInFrames}
        fps={renderPlan.output.fps}
        compositionWidth={renderPlan.output.width}
        compositionHeight={renderPlan.output.height}
        style={{ width: "100%" }}
        controls
        loop
      />
    </div>
  );
}
