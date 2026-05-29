import { structuredCall } from "../anthropic";
import { Clip, CompositionMode, StoryContext } from "../types";
import { clipCatalog } from "../timeline";
import { storyContextForPrompt } from "../story-context";
import { videoQualityContextForPrompt } from "../video-quality-context";
import {
  NarrationProposal,
  PlannedBeatProposal,
} from "../composition";
import { compositionSchema } from "./schemas";

const MODE_GUIDANCE: Record<CompositionMode, string> = {
  asset_driven:
    "Use ONLY clips from the catalog. Every beat must set assetStrategy=use_existing and list the catalog ids that satisfy it in requiredAssetIds. Do not plan any generation.",
  prompt_only:
    "Ignore any uploaded clips. Plan a generated asset for every beat: set assetStrategy to generate_image or generate_video, set generationKind, and write a concrete generationPrompt describing the shot.",
  hybrid:
    "Use catalog clips where they clearly fit a beat (assetStrategy=use_existing with requiredAssetIds). For beats with no good clip, plan generation (assetStrategy=generate_image or generate_video with generationKind and generationPrompt).",
};

const SYSTEM = `You are the composition planner for an AI-native video editor.
Given a creative brief you produce a beat-by-beat plan describing, for each beat,
whether to use an existing asset or generate a new one. You never produce the
final timeline here; you only plan which assets are needed.

Rules:
- Beat durations should roughly sum to the target length.
- Favor a strong hook, a clear middle, and a payoff/CTA appropriate to the goal.
- Plan for production value: clear intent, purposeful scene progression,
  designed composition, motivated movement, cohesive tone, deliberate pacing,
  and an informational or emotional payoff.
- Only reference existing assets by the exact ids in the catalog.
- Prefer generated images over generated video unless motion is essential, since
  images are cheaper and faster.
- For narration: mode "generate" when Aividi should write/voice narration,
  "provided" when the brief already supplies a script or audio asset, otherwise
  "none". Put any provided or drafted script text in narration.script.`;

export async function planCompositionBeats(input: {
  goal: string;
  targetLengthSec: number;
  style: string;
  aspectRatio: string;
  mode: CompositionMode;
  storyContext?: StoryContext | null;
  clips: Clip[];
  mustUseAssetIds?: string[];
  avoidAssetIds?: string[];
  narration: { mode: "none" | "provided" | "generate"; script?: string };
}): Promise<{ beats: PlannedBeatProposal[]; narration: NarrationProposal }> {
  const sys = `${SYSTEM}

MODE: ${input.mode}
${MODE_GUIDANCE[input.mode]}

VIDEO QUALITY CONTEXT:
${videoQualityContextForPrompt()}

ASSET CATALOG:
${input.mode === "prompt_only" ? "(ignored in prompt_only mode)" : clipCatalog(input.clips)}`;

  const constraints: string[] = [];
  if (input.mustUseAssetIds?.length) {
    constraints.push(`Must use these asset ids: ${input.mustUseAssetIds.join(", ")}`);
  }
  if (input.avoidAssetIds?.length) {
    constraints.push(`Avoid these asset ids: ${input.avoidAssetIds.join(", ")}`);
  }

  const user = `Creative goal: ${input.goal}
Target length: ${input.targetLengthSec}s
Style: ${input.style}
Aspect ratio: ${input.aspectRatio}
Narration mode requested: ${input.narration.mode}${
    input.narration.script ? `\nNarration script: ${input.narration.script}` : ""
  }
${constraints.length ? `Constraints:\n${constraints.join("\n")}\n` : ""}
Story context:
${storyContextForPrompt(input.storyContext)}

Produce the composition beats and narration plan now.`;

  const out = await structuredCall<{
    beats: PlannedBeatProposal[];
    narration: { mode: "none" | "provided" | "generate"; script?: string };
  }>({ cachedSystem: sys, user, schema: compositionSchema, maxTokens: 4000 });

  return {
    beats: out.beats,
    narration: {
      mode: out.narration?.mode || input.narration.mode,
      script: out.narration?.script || input.narration.script,
    },
  };
}
