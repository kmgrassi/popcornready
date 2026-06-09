import assert from "node:assert/strict";
import test from "node:test";

import { buildStoryFlowToolPlan, storyFlowRequiresApproval } from "./story-flow-tools";
import { GenerationJobInput, VideoBriefInput } from "@popcorn/shared/v1/types";

function jobInput(overrides: Partial<GenerationJobInput> = {}): GenerationJobInput {
  return {
    briefVersionId: "brief_1",
    assetIds: [],
    generatedAssetJobIds: [],
    variantCount: 1,
    ...overrides,
  };
}

function brief(overrides: Partial<VideoBriefInput> = {}): VideoBriefInput {
  return {
    goal: "A comedy set in space where explorers keep cloning themselves.",
    targetLengthSec: 90,
    aspectRatio: "16:9",
    ...overrides,
  };
}

test("story tool plan keeps the fixed engine fallback and ordered story tools", () => {
  const plan = buildStoryFlowToolPlan({
    projectId: "project_1",
    jobInput: jobInput(),
    brief: brief(),
  });

  assert.equal(plan.fallback, "fixed_generation_engine");
  assert.deepEqual(
    plan.invocations.map((invocation) => invocation.toolName),
    [
      "develop_story_blueprint",
      "draft_script",
      "plan_shots",
      "plan_visual_anchors",
      "generate_storyboard",
      "assemble_timeline",
      "critique_timeline",
      "export_video",
    ]
  );
});

test("story tool plan inserts approval before media work for long-form runs", () => {
  const plan = buildStoryFlowToolPlan({
    projectId: "project_1",
    jobInput: jobInput({ assetIds: ["asset_1"], mode: "hybrid" }),
    brief: brief({ targetLengthSec: 180 }),
  });
  const tools = plan.invocations.map((invocation) => invocation.toolName);

  assert.equal(storyFlowRequiresApproval(brief({ targetLengthSec: 180 })), true);
  assert.ok(tools.includes("request_approval"));
  assert.ok(tools.indexOf("generate_storyboard") < tools.indexOf("request_approval"));
  assert.ok(tools.indexOf("request_approval") < tools.indexOf("generate_keyframe"));
  assert.ok(tools.includes("generate_clip"));
  assert.ok(tools.includes("generate_audio"));
});
