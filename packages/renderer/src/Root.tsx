import React from "react";
import { Composition } from "remotion";
import { VideoComposition, VideoProps } from "./VideoComposition";
import { dims, timelineDurationSec } from "@popcorn/shared/types";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="main"
      component={VideoComposition as React.FC}
      durationInFrames={300}
      fps={30}
      width={1080}
      height={1920}
      defaultProps={{ timeline: null, clips: [], baseUrl: "" }}
      calculateMetadata={(data: any) => {
        const props = data.props as VideoProps;
        const fps = props.renderPlan?.output.fps ?? props.timeline?.fps ?? 30;
        const { width, height } = props.renderPlan?.output ?? dims(
          props.timeline?.aspectRatio ?? "9:16"
        );
        const durationSec =
          props.renderPlan?.durationSec ?? timelineDurationSec(props.timeline);
        const durationInFrames = Math.max(
          1,
          Math.round(durationSec * fps)
        );
        return { durationInFrames, fps, width, height };
      }}
    />
  );
};
