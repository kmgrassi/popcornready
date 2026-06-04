import React from "react";
import { Player } from "@remotion/player";
import { VideoComposition } from "@popcorn/renderer/VideoComposition";
import { createRenderPlanFromTimeline } from "@popcorn/timeline/render-plan";
import type { Clip, Timeline } from "@popcorn/shared/types";

export interface PreviewPlayerProps {
  timeline: Timeline | null;
  clips?: Clip[];
  baseUrl?: string;
  includeAudio?: boolean;
  audioClipIds?: string[];
}

export function PreviewPlayer({
  timeline,
  clips = [],
  baseUrl = "",
  includeAudio,
  audioClipIds,
}: PreviewPlayerProps) {
  if (!timeline || timeline.segments.length === 0) {
    return (
      <div className="player-wrap" style={{ aspectRatio: "9 / 16" }}>
        <div className="preview-player-empty">
          Your AI rough cut will preview here once generated.
        </div>
      </div>
    );
  }

  const audioIds =
    audioClipIds ??
    clips.filter((clip) => clip.kind === "audio").map((clip) => clip.id);
  const audioClips = clips.filter((clip) => audioIds.includes(clip.id));
  const { renderPlan } = createRenderPlanFromTimeline({
    timeline,
    audioClips,
  });
  const durationInFrames = Math.max(
    1,
    Math.round(renderPlan.durationSec * renderPlan.output.fps)
  );

  return (
    <div className="player-wrap">
      <Player
        component={VideoComposition as React.FC}
        inputProps={{
          timeline,
          renderPlan,
          clips,
          baseUrl,
          includeAudio: includeAudio ?? audioIds.length > 0,
          audioClipIds: audioIds,
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
