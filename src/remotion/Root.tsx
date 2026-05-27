import React from "react";
import { Composition } from "remotion";
import { VideoComposition, VideoProps } from "./VideoComposition";
import { dims, timelineDurationSec } from "../lib/types";

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
        const fps = props.timeline?.fps ?? 30;
        const { width, height } = dims(
          props.timeline?.aspectRatio ?? "9:16"
        );
        const durationInFrames = Math.max(
          1,
          Math.round(timelineDurationSec(props.timeline) * fps)
        );
        return { durationInFrames, fps, width, height };
      }}
    />
  );
};
