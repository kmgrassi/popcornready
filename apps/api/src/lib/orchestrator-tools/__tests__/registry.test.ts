import assert from "node:assert/strict";
import test from "node:test";

import type { AuthContext } from "@/lib/api/v1/auth";
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
        {
          id: "beat_1",
          name: "Hook",
          durationSec: 5,
          intent: "Introduce the premise.",
        },
      ],
    },
  ],
};

test("registry rejects duplicate tool names", () => {
  const registry = new ToolRegistry();
  registry.register(createPlanShotsTool({ planEdit: async () => samplePlan }));

  assert.throws(
    () => registry.register(createPlanShotsTool({ planEdit: async () => samplePlan })),
    /already registered/
  );
});

test("default registry exposes plan_shots metadata", () => {
  const registry = createDefaultToolRegistry({
    planShots: { planEdit: async () => samplePlan },
  });
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

test("plan_shots validates input before calling the agent", async () => {
  let calls = 0;
  const registry = createDefaultToolRegistry({
    planShots: {
      planEdit: async () => {
        calls += 1;
        return samplePlan;
      },
    },
  });

  const result = await registry.execute(
    "plan_shots",
    { goal: "", targetLengthSec: 0, style: "ad", aspectRatio: "4:3" },
    { auth, projectId: "proj_1" }
  );

  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.equal(result.error.kind, "invalid_input");
    assert.equal(result.error.recoverable, true);
  }
  assert.equal(calls, 0);
});

test("plan_shots wraps planEdit in a succeeded tool result envelope", async () => {
  const registry = createDefaultToolRegistry({
    planShots: {
      planEdit: async (input) => ({
        ...samplePlan,
        targetLengthSec: input.targetLengthSec,
        style: input.style,
        aspectRatio: input.aspectRatio as EditPlan["aspectRatio"],
      }),
    },
  });

  const result = (await registry.execute(
    "plan_shots",
    {
      goal: "a comedy about a space diner",
      targetLengthSec: 30,
      style: "deadpan",
      aspectRatio: "9:16",
    },
    { auth, projectId: "proj_1" }
  )) as ToolCallResult<PlanShotsOutput>;

  assert.equal(result.status, "succeeded");
  if (result.status === "succeeded") {
    assert.deepEqual(result.resourceIds, []);
    assert.equal(result.output?.plan.targetLengthSec, 30);
    assert.equal(result.output?.plan.style, "deadpan");
    assert.equal(result.output?.plan.aspectRatio, "9:16");
  }
});

test("registry parses input before running cost estimate hook", async () => {
  const registry = createDefaultToolRegistry({
    planShots: { planEdit: async () => samplePlan },
  });

  const estimate = await registry.estimateCost(
    "plan_shots",
    {
      goal: "a product demo",
      targetLengthSec: 15,
      style: "crisp",
      aspectRatio: "1:1",
    },
    { auth, projectId: "proj_1" }
  );

  assert.equal(estimate.estimatedCostUsd, 0);
  assert.equal(estimate.unit, "model_call");
});
