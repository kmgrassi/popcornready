import { createBriefTool, type CreateBriefDeps } from "./create-or-load-brief";
import { createPlanShotsTool, type PlanShotsDeps } from "./plan-shots";
import { ToolRegistry } from "./registry";

export interface DefaultToolRegistryDeps {
  planShots?: Partial<PlanShotsDeps>;
  createBrief?: Partial<CreateBriefDeps>;
}

export function createDefaultToolRegistry(
  deps: DefaultToolRegistryDeps = {}
): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(createBriefTool(deps.createBrief));
  registry.register(createPlanShotsTool(deps.planShots));
  return registry;
}
