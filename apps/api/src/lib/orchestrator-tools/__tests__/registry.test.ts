import assert from "node:assert/strict";
import test from "node:test";

import type { AuthContext } from "@/lib/api/v1/auth";
import type { VideoBrief } from "@/lib/api/v1/schemas";
import type { EditPlan } from "@popcorn/shared/types";
import { createDefaultToolRegistry } from "../default-registry";
import {
  createPlanShotsTool,
  persistedEditPlanSchema,
  type PlanShotsOutput,
} from "../plan-shots";
import { ToolRegistry } from "../registry";
import type { ToolCallResult } from "../types";

const auth: AuthContext = {
  mode: "local",
  actor: { id: "local_dev", type: "local" },
  workspaceId: "00000000-0000-0000-0000-000000000001",
  isLocal: true,
};

const samplePlan: EditPlan = {
  targetLengthSec: 20,
  style: "playful",
  aspectRatio: "16:9",
  scenes: [
    {
      id: "scene_1",
      name: "Setup",
      beats: [
        { id: "beat_1", name: "Hook", durationSec: 5, intent: "Introduce the premise." },
      ],
    },
  ],
};

const sampleBrief: VideoBrief = {
  goal: "A comedy about a space diner.",
  targetLengthSec: 30,
  aspectRatio: "9:16",
  style: "deadpan",
};

const activeBrief = {
  brief: sampleBrief,
  assetId: "brief_asset_1",
  contentHash: "brief_hash_1",
};

// Deps that satisfy plan_shots without touching the DB.
function planShotsDeps(over: Partial<Parameters<typeof createPlanShotsTool>[0]> = {}) {
  return {
    planEdit: async () => samplePlan,
    getActiveProjectBrief: async () => activeBrief,
    addProjectPlan: async () => ({ planAssetId: "plan_asset_1" }),
    ...over,
  };
}

test("registry rejects duplicate tool names", () => {
  const registry = new ToolRegistry();
  registry.register(createPlanShotsTool(planShotsDeps()));

  assert.throws(
    () => registry.register(createPlanShotsTool(planShotsDeps())),
    /already registered/
  );
});

test("default registry exposes plan_shots metadata", () => {
  const registry = createDefaultToolRegistry({ planShots: planShotsDeps() });
  const definition = registry.get("plan_shots");

  assert.equal(definition.name, "plan_shots");
  assert.equal(definition.execution, "sync");
  assert.equal(definition.inputSchema.type, "object");
  assert.equal(definition.outputSchema.type, "object");
});

test("plan_shots output schema describes the post-processed plan ids", () => {
  const scenes = persistedEditPlanSchema.properties.scenes as {
    items: { properties: Record<string, unknown>; required: string[] };
  };
  const beats = scenes.items.properties.beats as {
    items: { properties: Record<string, unknown>; required: string[] };
  };

  assert.ok(scenes.items.properties.id);
  assert.ok(scenes.items.required.includes("id"));
  assert.ok(beats.items.properties.id);
  assert.ok(beats.items.required.includes("id"));
});

test("plan_shots validates input before reading the brief or calling the agent", async () => {
  let planCalls = 0;
  let briefCalls = 0;
  const registry = createDefaultToolRegistry({
    planShots: planShotsDeps({
      planEdit: async () => {
        planCalls += 1;
        return samplePlan;
      },
      getActiveProjectBrief: async () => {
        briefCalls += 1;
        return activeBrief;
      },
    }),
  });

  const result = await registry.execute(
    "plan_shots",
    { feedback: 123 },
    { auth, projectId: "proj_1" }
  );

  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.equal(result.error.kind, "invalid_input");
    assert.equal(result.error.recoverable, true);
  }
  assert.equal(planCalls, 0);
  assert.equal(briefCalls, 0);
});

test("plan_shots returns precondition_unmet (suggesting the brief) when none exists", async () => {
  let planCalls = 0;
  const registry = createDefaultToolRegistry({
    planShots: planShotsDeps({
      getActiveProjectBrief: async () => null,
      planEdit: async () => {
        planCalls += 1;
        return samplePlan;
      },
    }),
  });

  const result = await registry.execute("plan_shots", {}, { auth, projectId: "proj_1" });

  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.equal(result.error.kind, "precondition_unmet");
    assert.equal(result.error.recoverable, true);
    assert.equal(
      result.error.unmetRequirements?.[0]?.satisfyWith.tool,
      "create_or_load_brief"
    );
  }
  assert.equal(planCalls, 0, "must not plan without a brief");
});

test("plan_shots derives the plan from the brief and persists it with brief provenance", async () => {
  let planEditInput: { goal: string; aspectRatio: string } | undefined;
  let planInput:
    | { plan: EditPlan; briefAssetId?: string; briefContentHash?: string }
    | undefined;
  const registry = createDefaultToolRegistry({
    planShots: planShotsDeps({
      getActiveProjectBrief: async () => activeBrief,
      planEdit: async (input) => {
        planEditInput = input;
        return samplePlan;
      },
      addProjectPlan: async (i) => {
        planInput = i;
        return { planAssetId: "plan_asset_1" };
      },
    }),
  });

  const result = (await registry.execute(
    "plan_shots",
    {},
    { auth, projectId: "proj_1" }
  )) as ToolCallResult<PlanShotsOutput>;

  // inputs are derived from the brief, not supplied by the model
  assert.equal(planEditInput?.goal, sampleBrief.goal);
  assert.equal(planEditInput?.aspectRatio, sampleBrief.aspectRatio);
  // the planned EditPlan is what gets persisted
  assert.equal(planInput?.plan, samplePlan);
  // the active brief is recorded as the plan's input (provenance / stale graph)
  assert.equal(planInput?.briefAssetId, "brief_asset_1");
  assert.equal(planInput?.briefContentHash, "brief_hash_1");

  assert.equal(result.status, "succeeded");
  if (result.status === "succeeded") {
    assert.deepEqual(result.resourceIds, ["plan_asset_1"]);
    assert.equal(result.output?.planAssetId, "plan_asset_1");
    assert.equal(result.output?.plan.aspectRatio, "16:9");
  }
});

test("registry parses input before running cost estimate hook", async () => {
  const registry = createDefaultToolRegistry({ planShots: planShotsDeps() });

  const estimate = await registry.estimateCost(
    "plan_shots",
    {},
    { auth, projectId: "proj_1" }
  );

  assert.equal(estimate.estimatedCostUsd, 0);
  assert.equal(estimate.unit, "model_call");
});
