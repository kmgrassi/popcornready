import { createPlanShotsTool, type PlanShotsDeps } from "./plan-shots";
import { ToolRegistry } from "./registry";

export interface DefaultToolRegistryDeps {
  planShots?: Partial<PlanShotsDeps>;
}

export function createDefaultToolRegistry(
  deps: DefaultToolRegistryDeps = {}
): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(createPlanShotsTool(deps.planShots));
  return registry;
}
