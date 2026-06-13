import assert from "node:assert/strict";
import test from "node:test";

import type { ToolExecutionContext as DriverContext } from "@/lib/orchestrator";
import { TOOL_NAMES } from "@/lib/orchestrator";
import { ToolRegistry } from "@/lib/orchestrator-tools/registry";
import type {
  ToolDefinition,
  ToolExecutionContext as RealContext,
} from "@/lib/orchestrator-tools/types";
import { toOrchestratorRegistry } from "../bridge";

function fakeTool(
  capture?: (input: unknown, context: RealContext) => void
): ToolDefinition<{ goal: string }, { echoed: string }> {
  return {
    name: "plan_shots",
    description: "fake plan_shots",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    execution: "async",
    parseInput: (input) => input as { goal: string },
    execute: (input, context) => {
      capture?.(input, context);
      return {
        status: "succeeded",
        resourceIds: [],
        output: { echoed: (input as { goal: string }).goal },
      };
    },
  };
}

const driverContext: DriverContext = {
  workspaceId: "ws_test",
  projectId: "proj_test",
  orchestratorRunId: "orch_test",
  actorId: "actor_test",
};

test("only-mode bridges a single tool and maps execution to mode", () => {
  const real = new ToolRegistry();
  real.register(fakeTool());
  const registry = toOrchestratorRegistry(real, { only: "plan_shots" });

  assert.equal(registry.size, 1);
  const def = registry.get("plan_shots");
  assert.ok(def);
  assert.equal(def?.name, "plan_shots");
  assert.equal(def?.mode, "async"); // execution → mode
});

test("bridged execute delegates to the real registry and synthesizes auth", async () => {
  let seen: RealContext | undefined;
  const real = new ToolRegistry();
  real.register(fakeTool((_input, context) => (seen = context)));
  const registry = toOrchestratorRegistry(real, { only: "plan_shots" });

  const result = await registry.get("plan_shots")!.execute({ goal: "hi" }, driverContext);

  assert.equal(result.status, "succeeded");
  if (result.status === "succeeded") {
    assert.deepEqual(result.output, { echoed: "hi" });
  }
  // driver context is mapped into a local AuthContext for the real tool
  assert.equal(seen?.auth.workspaceId, "ws_test");
  assert.equal(seen?.auth.actor.id, "actor_test");
  assert.equal(seen?.projectId, "proj_test");
});

test("all-mode exposes the full vocabulary with stubs for unimplemented tools", async () => {
  const real = new ToolRegistry();
  real.register(fakeTool());
  const registry = toOrchestratorRegistry(real);

  assert.equal(registry.size, TOOL_NAMES.length);

  // implemented tool is the real (bridged) one
  const planShots = await registry.get("plan_shots")!.execute({ goal: "x" }, driverContext);
  assert.equal(planShots.status, "succeeded");

  // an unimplemented tool falls back to the driver stub
  const exportVideo = await registry.get("export_video")!.execute({}, driverContext);
  assert.equal(exportVideo.status, "failed");
  if (exportVideo.status === "failed") {
    assert.equal(exportVideo.error.kind, "precondition_unmet");
  }
});
