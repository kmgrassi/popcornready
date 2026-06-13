// Adapts the rich `orchestrator-tools` registry (parseInput/execution shape,
// auth-context execution) into the `orchestrator` driver registry shape
// (mode/requiredResourceIds, workspace-context execution) so the real tool
// handlers can be driven by runToolLoopTurn.

import type { AuthContext } from "@/lib/api/v1/auth";
import {
  createToolRegistry,
  type ToolDefinition as OrchestratorToolDefinition,
  type ToolExecutionContext as OrchestratorContext,
  type ToolName,
  type ToolRegistry as OrchestratorRegistry,
} from "@/lib/orchestrator";
import type { ToolRegistry as RealToolRegistry } from "@/lib/orchestrator-tools/registry";

// The driver context carries a workspaceId + optional actorId; the real tools
// expect a full AuthContext. Synthesize a local-mode identity for it (the
// harness always runs under AUTH_MODE=local against a throwaway workspace).
function bridgeContext(context: OrchestratorContext): {
  auth: AuthContext;
  projectId?: string;
} {
  const auth: AuthContext = {
    mode: "local",
    actor: { id: context.actorId ?? "local_dev", type: "local" },
    workspaceId: context.workspaceId,
    isLocal: true,
  };
  return { auth, projectId: context.projectId };
}

function bridgeTool(real: RealToolRegistry, name: ToolName): OrchestratorToolDefinition {
  const definition = real.get(name);
  return {
    name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
    requiredResourceIds: [],
    mode: definition.execution,
    estimateCostUsd: () => undefined,
    // Delegate to the registry's execute (which runs parseInput + maps
    // ToolInputError to a failed result) so validation behaves identically to
    // production.
    execute: (input, context) => real.execute(name, input, bridgeContext(context)),
  };
}

export interface BridgeOptions {
  /** Expose only this tool (default behaviour: isolate the tool under test). */
  only?: ToolName;
}

// Build a driver-shaped registry from the real tool registry. With `only`, the
// model sees a single tool (forces input-shaping). Without it, the full
// vocabulary is exposed — real handlers where implemented, declared stubs
// elsewhere — so the model's tool *selection* can be tested too.
export function toOrchestratorRegistry(
  real: RealToolRegistry,
  options: BridgeOptions = {}
): OrchestratorRegistry {
  if (options.only) {
    return new Map([[options.only, bridgeTool(real, options.only)]]);
  }
  const registry = createToolRegistry();
  for (const definition of real.list()) {
    registry.set(definition.name, bridgeTool(real, definition.name));
  }
  return registry;
}
