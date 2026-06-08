import { GenerationJobInput, VideoBriefInput } from "@popcorn/shared/v1/types";

export type StoryFlowToolName =
  | "develop_story_blueprint"
  | "draft_script"
  | "plan_shots"
  | "plan_visual_anchors"
  | "request_approval"
  | "generate_storyboard"
  | "generate_keyframe"
  | "generate_clip"
  | "generate_audio"
  | "assemble_timeline"
  | "critique_timeline"
  | "export_video";

export interface StoryFlowToolInvocationDraft {
  toolName: StoryFlowToolName;
  input: Record<string, unknown>;
  reason: string;
}

export interface StoryFlowToolPlan {
  projectId: string;
  briefVersionId: string;
  fallback: "fixed_generation_engine";
  invocations: StoryFlowToolInvocationDraft[];
}

export interface BuildStoryFlowToolPlanInput {
  projectId: string;
  jobInput: GenerationJobInput;
  brief: VideoBriefInput;
}

const LONG_FORM_APPROVAL_THRESHOLD_SEC = 120;

function baseStoryInputs(input: BuildStoryFlowToolPlanInput): Record<string, unknown> {
  return {
    projectId: input.projectId,
    briefVersionId: input.jobInput.briefVersionId,
  };
}

function hasMediaWork(input: GenerationJobInput): boolean {
  return (
    input.assetIds.length > 0 ||
    input.generatedAssetJobIds.length > 0 ||
    input.allowGeneratedGapFill === true ||
    input.mode === "prompt_only" ||
    input.mode === "hybrid"
  );
}

function needsAudio(input: GenerationJobInput): boolean {
  return input.assetIds.length > 0 || input.mode === "prompt_only" || input.mode === "hybrid";
}

export function storyFlowRequiresApproval(brief: VideoBriefInput): boolean {
  return brief.targetLengthSec > LONG_FORM_APPROVAL_THRESHOLD_SEC;
}

export function buildStoryFlowToolPlan(
  input: BuildStoryFlowToolPlanInput
): StoryFlowToolPlan {
  const base = baseStoryInputs(input);
  const invocations: StoryFlowToolInvocationDraft[] = [
    {
      toolName: "develop_story_blueprint",
      input: {
        ...base,
        targetLengthSec: input.brief.targetLengthSec,
        goal: input.brief.goal,
      },
      reason: "Migrate story development from fixed planning to a tool-call turn.",
    },
    {
      toolName: "draft_script",
      input: base,
      reason: "Draft narration/script as an observable story-flow tool result.",
    },
    {
      toolName: "plan_shots",
      input: {
        ...base,
        aspectRatio: input.brief.aspectRatio,
        style: input.brief.style,
      },
      reason: "Convert the script and brief into scene/beat shot IDs.",
    },
    {
      toolName: "plan_visual_anchors",
      input: base,
      reason: "Detect reusable character and setting anchors before media spend.",
    },
  ];

  if (storyFlowRequiresApproval(input.brief)) {
    invocations.push({
      toolName: "request_approval",
      input: {
        ...base,
        gate: "pre_asset_story_flow",
        requiredBecause: `targetLengthSec exceeds ${LONG_FORM_APPROVAL_THRESHOLD_SEC}`,
      },
      reason: "Long-form runs require user approval before expensive media generation.",
    });
  }

  invocations.push({
    toolName: "generate_storyboard",
    input: base,
    reason: "Generate cheap storyboard/pre-viz before keyframes or clips.",
  });

  if (hasMediaWork(input.jobInput)) {
    invocations.push(
      {
        toolName: "generate_keyframe",
        input: {
          ...base,
          assetIds: input.jobInput.assetIds,
          generatedAssetJobIds: input.jobInput.generatedAssetJobIds,
        },
        reason: "Produce photoreal first frames from approved storyboard context.",
      },
      {
        toolName: "generate_clip",
        input: {
          ...base,
          assetIds: input.jobInput.assetIds,
          generatedAssetJobIds: input.jobInput.generatedAssetJobIds,
        },
        reason: "Generate or select clip media for planned beats.",
      }
    );
  }

  if (needsAudio(input.jobInput)) {
    invocations.push({
      toolName: "generate_audio",
      input: base,
      reason: "Prepare narration/audio against the drafted script.",
    });
  }

  invocations.push(
    {
      toolName: "assemble_timeline",
      input: base,
      reason: "Assemble the selected media into a timeline artifact.",
    },
    {
      toolName: "critique_timeline",
      input: base,
      reason: "Review the assembled timeline and request targeted fixes if needed.",
    },
    {
      toolName: "export_video",
      input: base,
      reason: "Expose export as the terminal story-flow tool.",
    }
  );

  return {
    projectId: input.projectId,
    briefVersionId: input.jobInput.briefVersionId,
    fallback: "fixed_generation_engine",
    invocations,
  };
}

export function shouldUseStoryFlowToolLoop(env = process.env): boolean {
  return env.POPCORN_STORY_FLOW_TOOL_LOOP === "1";
}
